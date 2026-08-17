"""Durable, cross-session memory for the AI assistant.

Extraction (write): after each assistant turn, a cheap LLM call distills up to
MEMORY_PER_TURN discrete durable facts. Facts are deduped against existing active
memories and stored (PySpamNote uses pgvector for embedding similarity, with a
keyword fallback). Storage is capped (MEMORY_MAX_ACTIVE) with the oldest evicted
to keep cost and context bounded.

Retrieval (read): given a user message, return the top-k active memories most
likely relevant, so ``build_messages`` can inject a compact "RECALLED MEMORY"
block instead of re-sending raw history.
"""

import json
from uuid import UUID

MEMORY_TOP_K = 5
MEMORY_PER_TURN = 5
MEMORY_MAX_ACTIVE = 60
MEMORY_INJECT_MAX_TOKENS = 400


def _extraction_prompt(transcript: str) -> str:
    return (
        "You distill durable, cross-session facts from a task-management chat so "
        "the assistant can recall them later (appointments, preferences, life "
        "context, recurring commitments). Return ONLY a JSON array of up to "
        f"{MEMORY_PER_TURN} objects, each with a \"content\" string (a single "
        "discrete fact, first-person from the USER's perspective) and a "
        "\"category\" string (one of: task | preference | schedule | context). "
        "Skip trivia, one-off task minutiae, and anything already implied by the "
        "raw chat history. Empty array if nothing durable is worth remembering.\n\n"
        f"Chat\n{transcript}\n\nJSON:"
    )


async def extract_memories(client, history: list[dict], user_message: str, assistant_content: str) -> list[dict]:
    """Call the cheap extraction LLM and return [{content, category}].
    Fail-open: any error returns [] so memory never blocks or breaks a turn."""
    if assistant_content and not (user_message or history):
        return []
    transcript_parts = [
        str(m.get("role", "")) + ": " + str(m.get("content", ""))[:400]
        for m in history[-6:]
        if m.get("role") in ("user", "assistant", "tool")
    ]
    transcript_parts.extend([f"user: {user_message}", f"assistant: {assistant_content}"])
    transcript = "\n".join(transcript_parts)
    if len(transcript) > 4000:
        transcript = transcript[-4000:]

    try:
        resp = await client.chat(
            [{"role": "user", "content": _extraction_prompt(transcript)}],
            tools=None,
            temperature=0.1,
            max_tokens=300,
        )
        content = (resp.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()
        # Strip markdown code fences if the model wraps the JSON.
        if content.startswith("```"):
            content = content.strip("`")
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()
        data = json.loads(content)
        if not isinstance(data, list):
            return []
        out = []
        for item in data[:MEMORY_PER_TURN]:
            if not isinstance(item, dict):
                continue
            c = str(item.get("content", "")).strip()
            if len(c) < 12:
                continue
            cat = str(item.get("category", "context") or "context").strip().lower()
            if cat not in ("task", "preference", "schedule", "context"):
                cat = "context"
            out.append({"content": c, "category": cat})
        return out
    except Exception:
        return []


def _normalize(text: str) -> str:
    return " ".join(text.lower().split())[:200]


def _is_near_duplicate(existing: list[str], content: str, threshold: float = 0.92) -> bool:
    """Cheap exact+prefix similarity dedupe (no expensive embedding comparison).
    Rejects a candidate when it overlaps an existing active memory almost fully."""
    a = _normalize(content)
    words_a = set(a.split())
    for ex in existing:
        b = _normalize(ex)
        if not b:
            continue
        if a == b and len(a) > 0:
            return True
        words_b = set(b.split())
        if not words_a or not words_b:
            continue
        overlap = len(words_a & words_b) / max(len(words_a | words_b), 1)
        if overlap >= threshold and min(len(words_a), len(words_b)) >= 3:
            return True
    return False


async def store_memories(
    session,
    user_id: str,
    source_session_id: str | None,
    memories: list[dict],
) -> int:
    """Persist extracted memories with dedupe + cap. Returns number stored.
    Fail-open: no exception propagates (caller must not break the turn)."""
    if not memories:
        return 0
    from sqlalchemy import delete, select
    from app.models.ai_memory import AiMemory

    user_id_uuid = UUID(str(user_id))
    source_uuid = UUID(str(source_session_id)) if source_session_id else None

    try:
        result = await session.execute(
            select(AiMemory.content).where(
                AiMemory.user_id == user_id_uuid, AiMemory.is_active.is_(True)
            )
        )
        existing = [c for (c,) in result.all()]

        stored = 0
        for mem in memories:
            content = str(mem.get("content", "")).strip()
            if not content or _is_near_duplicate(existing, content):
                continue
            session.add(
                AiMemory(
                    user_id=user_id_uuid,
                    content=content,
                    category=mem.get("category", "context"),
                    source_session_id=source_uuid,
                    is_active=True,
                )
            )
            existing.append(content)
            stored += 1

        if stored:
            await session.flush()
            # Keep storage bounded: count active memories and evict the oldest
            # beyond the cap in the same transaction.
            count_result = await session.execute(
                select(AiMemory.id, AiMemory.created_at)
                .where(AiMemory.user_id == user_id_uuid, AiMemory.is_active.is_(True))
                .order_by(AiMemory.created_at.desc())
            )
            rows = count_result.all()
            if len(rows) > MEMORY_MAX_ACTIVE:
                excess = [r[0] for r in rows[MEMORY_MAX_ACTIVE:]]
                await session.execute(
                    delete(AiMemory).where(AiMemory.id.in_(excess))
                )
        return stored
    except Exception:
        return 0


async def retrieve_relevant_memories(session, user_id: str, user_message: str) -> list[str]:
    """Top-k active memories relevant to the user's message (keyword match).
    Returns up to MEMORY_TOP_K content strings for prompt injection."""
    from sqlalchemy import select, or_
    from app.models.ai_memory import AiMemory

    user_id_uuid = UUID(str(user_id))
    try:
        result = await session.execute(
            select(AiMemory.content, AiMemory.category)
            .where(AiMemory.user_id == user_id_uuid, AiMemory.is_active.is_(True))
            .order_by(AiMemory.created_at.desc())
            .limit(200)
        )
        rows = result.all()
    except Exception:
        return []

    if not rows:
        return []

    tokens = {t for t in _normalize(user_message).split() if len(t) > 3}
    scored: list[tuple[int, str]] = []
    for content, category in rows:
        hay = _normalize(content)
        if not tokens:
            break
        score = sum(1 for t in tokens if t in hay)
        if score > 0:
            scored.append((score, content))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for (_, c) in scored[:MEMORY_TOP_K]]


async def list_active_memories(session, user_id: str, limit: int = 100) -> list[dict]:
    from sqlalchemy import select
    from app.models.ai_memory import AiMemory
    user_id_uuid = UUID(str(user_id))
    result = await session.execute(
        select(AiMemory)
        .where(AiMemory.user_id == user_id_uuid, AiMemory.is_active.is_(True))
        .order_by(AiMemory.created_at.desc())
        .limit(limit)
    )
    return [
        {
            "id": str(m.id),
            "content": m.content,
            "category": m.category,
            "source_session_id": str(m.source_session_id) if m.source_session_id else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in result.scalars().all()
    ]


async def purge_memories_for_session(session, user_id: str, source_session_id: str) -> int:
    """Hard-delete all active memories extracted from a session (used by delete
    so clearing a chat also clears the durable facts it produced)."""
    from sqlalchemy import delete
    from app.models.ai_memory import AiMemory
    user_id_uuid = UUID(str(user_id))
    result = await session.execute(
        delete(AiMemory).where(
            AiMemory.user_id == user_id_uuid,
            AiMemory.source_session_id == UUID(str(source_session_id)),
        )
    )
    return result.rowcount or 0
