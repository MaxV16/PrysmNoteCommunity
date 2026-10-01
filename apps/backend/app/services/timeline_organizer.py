"""AI topic organizer for timeline sections.

Classifies the user's dated, still-active tasks into a small set of short
topics and pins each task to a free ``board_sections`` (kind="timeline") row.
Runs on the user's own LLM access (hosted PrysmAI or BYOK) via
``resolve_llm_key``, so the spend is the user's own. Classification is bounded
(fixed batch size, capped task/topic counts) and idempotent: already-pinned
tasks are skipped unless ``force`` is set.
"""
import asyncio
import json
import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_section import BoardSection
from app.models.task import Task, TaskStatus
from app.models.user import User

# Bounds: keep the provider bill (and the section list) small. MAX_TASKS is the
# per-press budget; a run that hits it reports the leftover count in `remaining`
# so the user can press Auto-sort again instead of the run implying completion.
BATCH_SIZE = 40
MAX_TASKS = 1000
MAX_TOPICS = 20
# Headroom for reasoning models, whose reasoning tokens count against the same
# budget and would otherwise leave `content` empty for a full 40-task batch.
MAX_OUTPUT_TOKENS = 6000
SECTION_KINDS = "timeline"

# Token-friendly palette; a topic's color is stable for the life of the run.
TOPIC_COLORS = (
    "#4FC3F7", "#FFA726", "#66BB6A", "#EF5350", "#AB47BC",
    "#26A69A", "#FFCA28", "#8D6E63", "#42A5F5", "#EC407A",
    "#7E57C2", "#29B6F6", "#9CCC65", "#FF7043", "#5C6BC0",
    "#26C6DA", "#D4E157", "#FFA000", "#78909C", "#8E24AA",
)


def _normalize_topic(raw: Any, fallback: str = "Other") -> str:
    """Coerce a model-provided topic to 1-3 words in Title Case."""
    if not isinstance(raw, str):
        return fallback
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9&/+'.-]*", raw)[:3]
    if not words:
        return fallback
    return " ".join(w[:1].upper() + w[1:] for w in words)


def _extract_json_value(text: str):
    """Pull the first JSON array/object out of a possibly fenced response."""
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned).strip()
    candidates = []
    for opener, closer in (("[", "]"), ("{", "}")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if start != -1 and end > start:
            try:
                candidates.append(json.loads(cleaned[start : end + 1]))
            except (ValueError, TypeError):
                continue
    if candidates:
        return candidates[0]

    # Fallback for truncated/garbled JSON (e.g. output cut off at max_tokens):
    # scan for complete id/topic pairs in order. A half-written final object
    # simply does not match and is dropped.
    pairs = re.findall(
        r'"id"\s*:\s*"([^"]+)"\s*,\s*"(?:topic|section|category)"\s*:\s*"([^"]*)"',
        cleaned,
    )
    if pairs:
        return list(pairs)
    reversed_pairs = re.findall(
        r'"(?:topic|section|category)"\s*:\s*"([^"]*)"\s*,\s*"id"\s*:\s*"([^"]+)"',
        cleaned,
    )
    if reversed_pairs:
        return [(task_id, topic) for topic, task_id in reversed_pairs]
    return None


def _parse_assignments(text: str) -> dict[str, str]:
    """Map task id -> raw topic from a model response.

    Accepts the requested ``[{"id","topic"}]`` shape, a ``{"assignments":[...]}``
    wrapper, and a flat ``{"<id>": "<topic>"}`` map, plus the truncated-JSON
    fallback above.
    """
    data = _extract_json_value(text)
    if data is None:
        return {}

    out: dict[str, str] = {}
    if isinstance(data, dict):
        for key in ("assignments", "tasks", "results", "topics"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            for key, value in data.items():
                if isinstance(value, str):
                    out[str(key)] = value
            return out

    if isinstance(data, (list, tuple)):
        for item in data:
            # Truncated-fallback shape: ("<id>", "<topic>")
            if isinstance(item, (list, tuple)) and len(item) == 2:
                out[str(item[0])] = item[1] if isinstance(item[1], str) else ""
                continue
            if not isinstance(item, dict):
                continue
            task_id = item.get("id") or item.get("task_id")
            topic = item.get("topic") or item.get("section") or item.get("category")
            if task_id:
                out[str(task_id)] = topic if isinstance(topic, str) else ""
    return out


def _topic_prompt(existing_topics: list[str], tasks: list[Task]) -> str:
    listing = [
        {
            "id": str(t.id),
            "title": (t.title or "")[:160],
            "notes": (t.description or "")[:160],
        }
        for t in tasks
    ]
    existing = ", ".join(existing_topics) if existing_topics else "(none yet)"
    return (
        "You are organizing a personal task list into short topic sections.\n"
        f"Existing topics you should REUSE when they fit: {existing}\n\n"
        "For EACH task below choose exactly one topic: 1 to 3 words, Title Case, "
        "no punctuation, no numbering, no duplicates by meaning. Prefer the "
        "existing topics; only invent a new one when nothing fits. Use at most "
        f"{MAX_TOPICS} topics in total. Do NOT answer with prose.\n\n"
        'Return ONLY a JSON array: [{"id": "<task id>", "topic": "<topic>"}, ...]\n\n'
        f"Tasks:\n{json.dumps(listing, ensure_ascii=False)}"
    )


async def _resolve_provider(session: AsyncSession, user: User, requested: str | None) -> str:
    """Pick the LLM provider: requested, else hosted PrysmAI, else a BYOK key."""
    if requested and requested != "auto":
        return requested

    from app.services.ai_entitlement import check_ai_allowance

    ent = await check_ai_allowance(str(user.id), session)
    if ent.get("mode") == "prysmai" and not ent.get("blocked"):
        return "prysmai"

    from app.models.api_key import ApiKey

    result = await session.execute(
        select(ApiKey.provider).where(
            ApiKey.user_id == user.id, ApiKey.is_active.is_(True)
        )
    )
    providers = [p for (p,) in result.all()]
    for preferred in ("openai", "gemini", "deepseek", "openrouter"):
        if preferred in providers:
            return preferred
    if providers:
        return providers[0]
    return "prysmai"


async def _load_tasks(session: AsyncSession, user_id, *, force: bool, list_id=None) -> list[Task]:
    query = (
        select(Task)
        .where(
            Task.user_id == user_id,
            Task.deleted_at.is_(None),
            Task.is_archived.is_(False),
            Task.status != TaskStatus.CANCELLED,
            (Task.start_date.is_not(None)) | (Task.due_date.is_not(None)),
        )
        .order_by(Task.created_at)
        .limit(MAX_TASKS)
    )
    query = query.where(
        Task.list_id.is_(None) if list_id is None else Task.list_id == list_id
    )
    if not force:
        query = query.where(Task.board_section_id.is_(None))
    result = await session.execute(query)
    return list(result.scalars().all())


async def _count_remaining(session: AsyncSession, user_id, list_id=None) -> int:
    """Active dated tasks still unpinned after a run (the work left for the next
    press). Counted in the same transaction, so rows pinned above are already
    visible."""
    result = await session.execute(
        select(func.count())
        .select_from(Task)
        .where(
            Task.user_id == user_id,
            Task.deleted_at.is_(None),
            Task.is_archived.is_(False),
            Task.status != TaskStatus.CANCELLED,
            Task.board_section_id.is_(None),
            (Task.start_date.is_not(None)) | (Task.due_date.is_not(None)),
            Task.list_id.is_(None) if list_id is None else Task.list_id == list_id,
        )
    )
    return int(result.scalar_one() or 0)


async def _existing_timeline_sections(session: AsyncSession, user_id, list_id=None) -> list[BoardSection]:
    result = await session.execute(
        select(BoardSection)
        .where(
            BoardSection.user_id == user_id,
            BoardSection.kind == SECTION_KINDS,
            BoardSection.list_id.is_(None) if list_id is None else BoardSection.list_id == list_id,
        )
        .order_by(BoardSection.position, BoardSection.created_at)
    )
    return list(result.scalars().all())


async def organize_timeline(
    session: AsyncSession,
    user: User,
    *,
    http_request=None,
    provider: str | None = None,
    force: bool = False,
    list_id=None,
) -> dict:
    """Classify a list's timeline tasks into topic sections.

    ``list_id`` scopes both the tasks considered and the sections created, so a
    list's sections never bleed into another list. Returns
    ``{sections_created, tasks_assigned, topics, skipped, remaining}``
    where ``remaining`` is the count of active dated tasks still unpinned after
    the run (the work left for a second press). Raises
    ``HTTPException`` (from ``resolve_llm_key``) when the user has no usable AI
    access, or ``ValueError`` when there is nothing to organize.
    """
    from app.routers.ai import _build_llm_client, resolve_llm_key

    tasks = await _load_tasks(session, user.id, force=force, list_id=list_id)
    if not tasks:
        return {
            "sections_created": 0,
            "tasks_assigned": 0,
            "topics": [],
            "skipped": True,
            "remaining": 0,
        }

    resolved_provider = await _resolve_provider(session, user, provider)
    provider_name, api_key, chain = await resolve_llm_key(
        session, user, resolved_provider, http_request
    )
    # _build_llm_client is sync but wraps the async get_llm_client, so the call
    # returns a coroutine that must be awaited (missing this made every batch
    # fall into the per-batch except below and report a false "skipped").
    client = await _build_llm_client(provider_name, api_key, chain)

    # Reuse pinned section titles as candidate topics so reruns stay stable.
    sections = await _existing_timeline_sections(session, user.id, list_id)
    by_title: dict[str, BoardSection] = {s.title.strip().lower(): s for s in sections}
    topic_case: dict[str, str] = {s.title.strip().lower(): s.title for s in sections}
    existing_topics = list(topic_case.values())

    assignments: dict[str, str] = {}
    failed_batches = 0
    try:
        for start in range(0, len(tasks), BATCH_SIZE):
            batch = tasks[start : start + BATCH_SIZE]
            messages = [{"role": "user", "content": _topic_prompt(existing_topics, batch)}]
            from app.llm.base import first_choice

            # Up to 3 attempts per batch. Providers routinely return transient
            # 429s, and a single bad batch must not abort the whole run.
            response = None
            for attempt in range(3):
                try:
                    response = await client.chat(
                        messages, tools=None, temperature=0.2, max_tokens=MAX_OUTPUT_TOKENS
                    )
                    break
                except Exception:
                    if attempt < 2:
                        await asyncio.sleep(2 * (attempt + 1))
            if response is None:
                failed_batches += 1
                continue

            message = first_choice(response).get("message", {}) or {}
            content = message.get("content") or ""
            if not content.strip():
                # Reasoning models sometimes leave `content` empty and put the
                # whole answer (or its scratchpad) in `reasoning`; try it before
                # declaring the batch failed.
                content = message.get("reasoning") or ""
            parsed = _parse_assignments(content)
            if not parsed:
                failed_batches += 1
                continue
            for task in batch:
                raw = parsed.get(str(task.id))
                if raw is None:
                    # The model did not classify this task; leave it unpinned so
                    # a later pass retries it instead of dumping it into "Other".
                    continue
                topic = _normalize_topic(raw)
                key = topic.lower()
                canonical = topic_case.setdefault(key, topic)
                assignments[str(task.id)] = canonical
                if canonical not in existing_topics:
                    existing_topics.append(canonical)
    finally:
        try:
            await client.aclose()
        except Exception:
            pass

    if not assignments:
        if failed_batches:
            # Never report a false "nothing to do": surface the provider failure
            # so the user knows to retry instead of thinking the list is empty.
            raise RuntimeError(
                "Auto-sort could not reach the AI provider. Please try again."
            )
        return {
            "sections_created": 0,
            "tasks_assigned": 0,
            "topics": [],
            "skipped": True,
            "remaining": await _count_remaining(session, user.id, list_id),
        }

    # Clamp to MAX_TOPICS: keep the most-used and fold the rest into "Other".
    counts: dict[str, int] = {}
    for topic in assignments.values():
        counts[topic] = counts.get(topic, 0) + 1
    if len(counts) > MAX_TOPICS:
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        kept = {name for name, _ in ranked[: MAX_TOPICS - 1]}
        for task_id, topic in list(assignments.items()):
            if topic not in kept:
                assignments[task_id] = "Other"
        counts = {}
        for topic in assignments.values():
            counts[topic] = counts.get(topic, 0) + 1

    # Create missing sections (palette color by position), then pin tasks.
    created = 0
    next_position = (max((s.position for s in sections), default=-1)) + 1
    for index, (topic_name, _count) in enumerate(sorted(counts.items())):
        if topic_name.lower() in by_title:
            continue
        section = BoardSection(
            user_id=user.id,
            kind=SECTION_KINDS,
            list_id=list_id,
            title=topic_name,
            color=TOPIC_COLORS[index % len(TOPIC_COLORS)],
            status=None,
            position=next_position,
        )
        next_position += 1
        session.add(section)
        by_title[topic_name.lower()] = section
        created += 1
    await session.flush()

    assigned = 0
    for task in tasks:
        topic = assignments.get(str(task.id))
        if not topic:
            continue
        section = by_title.get(topic.strip().lower())
        if section is None:
            continue
        task.board_section_id = section.id
        assigned += 1
    await session.flush()

    return {
        "sections_created": created,
        "tasks_assigned": assigned,
        "topics": sorted(counts.keys()),
        "skipped": False,
        "remaining": await _count_remaining(session, user.id, list_id),
    }
