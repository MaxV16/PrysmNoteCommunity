"""Background turn runner for AI chat.

Manages one active AI turn per account. A new message while one is running gets
HTTP 409. The runner lives in-process (asyncio task) so a uvicorn restart loses
in-flight turns, but persisted rows survive and the user re-asks.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.llm.base import first_choice
from app.services.ai_shared import (
    _chunk_text,
    _normalize_reply_markdown,
    _parse_text_tool_calls,
    _safe_aclose,
    _strip_text_tool_calls,
)
from app.services.ai_service import (
    MONEY_NUDGE,
    _TOOL_REFUSAL_PATTERNS,
    _needs_tool_retry,
    build_messages,
    execute_tool_calls,
    finance_tool_names,
    get_llm_client,
    is_premium,
    money_intent,
    tools_for_user,
)
from app.services.memory_service import retrieve_relevant_memories
from app.utils.rls import (
    commit_and_reapply_rls,
    rls_session,
    rollback_and_reapply_rls,
    set_rls_user_id,
)

logger = logging.getLogger("app.ai_turn_runner")

MAX_TOOL_ROUNDS = 4
MAX_RETRY_BUMPS = 2

_APPLIED_LINE_CAP = 6


def _summarize_tool_result(content: str) -> str | None:
    """Turn one tool-result JSON into a short human line, or None when the
    result records no user-visible side effect (a read-only listing, an error,
    a no-op).

    Handles the generic applied-action keys the handlers emit: created,
    created_count, updated, deleted, completed, cancelled(+count), plus the
    entity name from task.title/name. E.g. 'Added task "Car mechanic
    appointment" (2026-09-07)'.
    """
    try:
        payload = json.loads(content)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("error"):
        return None
    # Plain read-only listings (searches, tag lists, financial listings,
    # projections) are not applied actions.
    if not any(
        k in payload
        for k in (
            "created", "created_count", "updated", "deleted", "completed",
            "cancelled", "cancelled_count",
        )
    ):
        return None
    if payload.get("created_count"):
        n = payload["created_count"]
        return f"Added {n} task(s)"
    if payload.get("cancelled_count"):
        n = payload["cancelled_count"]
        return f"Cancelled {n} task(s)" if n > 0 else None
    task = payload.get("task") if isinstance(payload.get("task"), dict) else None
    name = payload.get("name") or (task or {}).get("title") or payload.get("title")
    if payload.get("created") is True:
        label = "Added"
    elif payload.get("completed") is True:
        label = "Completed"
    elif payload.get("deleted") is True:
        label = "Deleted"
    elif payload.get("updated") is True:
        label = "Updated"
    elif payload.get("cancelled") is True:
        label = "Cancelled"
    else:
        return None
    if name:
        date = (task or {}).get("start_date") or payload.get("start_date")
        suffix = f" ({date})" if date else ""
        return f'{label} "{name}"{suffix}'
    return f"{label} an item"


def _extract_applied_actions(tool_results: list[dict]) -> list[str]:
    """Human summaries of the committed side-effects in one tool round,
    preserving order and dropping duplicates."""
    lines = []
    for r in tool_results:
        line = _summarize_tool_result((r or {}).get("content", ""))
        if line and line not in lines:
            lines.append(line)
    return lines


def should_money_nudge(
    premium: bool,
    tool_calls: list[dict] | None,
    money_hit: bool,
    money_nudged: bool,
    current_model_index: int,
    chain_len: int,
) -> bool:
    """Decision helper for the money-routing safety net: nudge the model once
    toward the finance tools when a premium turn called only task tools on a
    money request and there is still a model bump left. Never nudges free users
    (they have no finance tools) and never nudges twice."""
    if not premium or money_nudged or not money_hit:
        return False
    if not tool_calls:
        return False
    if any(
        (tc.get("function", {}).get("name") or "") in finance_tool_names()
        for tc in tool_calls
    ):
        return False
    return current_model_index < min(chain_len - 1, MAX_RETRY_BUMPS)


def stream_fallback_reply(
    content: str,
    applied_actions: list[str],
    cold: str = "I couldn't get a response from the AI on that turn. "
    "Please try again or rephrase your request.",
) -> str:
    """Reply when the final stream died: prefer whatever the model already
    produced in tool rounds, else a summary of the committed actions, else the
    cold text (generic for the success path, "Interrupted." on exception)."""
    fallback = _strip_text_tool_calls(content).strip()
    if fallback:
        return fallback
    if applied_actions:
        return "Done before the stream cut out:\n" + "\n".join(
            f"- {a}" for a in applied_actions
        )
    return cold


async def _retry_final_non_streaming(client, messages, session, job) -> str:
    """One last non-streaming attempt when the final stream died with nothing
    else to report: some providers' streaming path can fail while the plain
    chat path still answers. Returns the reply text, or "" when it also fails
    or produces nothing."""
    try:
        response = await client.chat(messages, tools=None)
        await record_usage(session, job, response)
        return (first_choice(response).get("message", {}).get("content", "")) or ""
    except Exception:
        return ""


@dataclass
class TurnJob:
    user_id: str
    session_id: str
    provider: str
    api_key: str
    chain: list[str]
    sanitized_history: list[dict]
    user_message: str
    context: dict | None
    status: str = "running"  # running | done | error | cancelled
    phase: str = "tools"     # tools | final | done
    content: str = ""
    tool_calls: dict | None = None
    estimated_tokens: int = 0
    current_model_index: int = 0
    events: asyncio.Queue = field(default_factory=asyncio.Queue)
    done_event: asyncio.Event = field(default_factory=asyncio.Event)
    cancel_requested: bool = False
    # Human summaries of tool side-effects committed this turn, so a dropped
    # final stream can still report what was actually done.
    applied_actions: list[str] = field(default_factory=list)
    # True once the money-routing nudge has been delivered (never nudge twice).
    money_nudged: bool = False


_turns: dict[str, TurnJob] = {}
# Guards the check-and-register inside start_turn: two concurrent chat
# requests for the same user must never both register (the router's pre-check
# is not atomic across an await, and a second turn would double-run tools).
_start_lock = asyncio.Lock()


def get_active_turn(user_id: str) -> TurnJob | None:
    return _turns.get(user_id)


async def start_turn(
    user_id: str,
    session_id: str,
    provider: str,
    api_key: str,
    chain: list[str],
    sanitized_history: list[dict],
    user_message: str,
    context: dict | None = None,
) -> TurnJob | None:
    """Register and launch a background turn, or return ``None`` when the user
    already has an active turn (the caller must reply 409 then)."""
    async with _start_lock:
        existing = _turns.get(user_id)
        if existing is not None:
            return None
        job = TurnJob(
            user_id=user_id,
            session_id=session_id,
            provider=provider,
            api_key=api_key,
            chain=chain,
            sanitized_history=sanitized_history,
            user_message=user_message,
            context=context,
        )
        _turns[user_id] = job
    asyncio.create_task(_run_turn(job))
    return job


def cancel_turn(user_id: str) -> bool:
    job = _turns.get(user_id)
    if job is None:
        return False
    job.cancel_requested = True
    return True


async def _run_turn(job: TurnJob) -> None:
    # Lazy imports to avoid circular dependency with app.routers.ai
    from app.routers.ai import (
        chat_with_cache as _chat_with_cache,
        load_session_summary as _load_session_summary,
        persist_conversation as _persist_conversation,
        record_estimated_usage as _record_estimated_usage,
        _maybe_update_summary as _maybe_update_summary,
        _maybe_extract_memories as _maybe_extract_memories,
        _friendly_llm_error as _friendly_llm_error,
    )

    async def _pc(session, user_id, session_id, role, content, tool_calls=None):
        return await _persist_conversation(session, user_id, session_id, role, content, tool_calls)

    async def _reu(session, user_id, provider, messages, streamed):
        return await _record_estimated_usage(session, user_id, provider, messages, streamed)

    # Local aliases for imported functions
    _lss = _load_session_summary
    _cwc = _chat_with_cache
    _mus = _maybe_update_summary
    _mem = _maybe_extract_memories
    _fle = _friendly_llm_error
    _reu_fn = _reu

    client = None
    try:
        async with async_session_factory() as session:
            # RLS requires Postgres; guard for SQLite (CI/tests).
            dialect = session.bind.dialect.name if session.bind else "sqlite"
            is_pg = dialect == "postgresql"

            async def _commit():
                # A tool handler may have rolled the session back internally
                # (dropping the transaction-scoped RLS context) even when it
                # reported success. Re-apply BEFORE the commit so the pending
                # flush can never execute with app.user_id unset, then
                # commit_and_reapply_rls re-applies it again for the next
                # transaction.
                if is_pg:
                    await set_rls_user_id(session, UUID(job.user_id))
                await commit_and_reapply_rls(session, UUID(job.user_id))

            async def _rollback():
                await rollback_and_reapply_rls(session, UUID(job.user_id))

            async def _cancel_job_finish():
                """Finish cancelled turn."""
                job.status = "cancelled"
                job.phase = "done"
                job.content = "Interrupted."
                await _pc(session, job.user_id, job.session_id, "assistant", "Interrupted.")
                try:
                    await _commit()
                except Exception:
                    pass

            if is_pg:
                await set_rls_user_id(session, UUID(job.user_id))

            ai_session = await _lss(session, job.user_id, job.session_id)
            current_summary = ai_session.summary if ai_session else None

            memories = await retrieve_relevant_memories(session, job.user_id, job.user_message)
            premium = await is_premium(job.user_id, session)
            tools = tools_for_user(premium)
            messages = build_messages(
                job.sanitized_history,
                job.user_message,
                job.context,
                current_summary,
                memories,
                include_finance=premium,
            )

            await _pc(session, job.user_id, job.session_id, "user", job.user_message)
            await _commit()

            client = await _build_turn_client(job)
            content = ""
            tool_calls = None

            for _round in range(MAX_TOOL_ROUNDS):
                if job.cancel_requested:
                    return await _cancel_job_finish()

                # Recover the session if tool execution or retry logic left it stale.
                try:
                    if not session.is_active:
                        await _rollback()
                except Exception:
                    pass

                response = await _cwc(
                    session, job.user_id, job.provider, client, messages, tools,
                    model=job.chain[job.current_model_index] if job.chain else None,
                )
                choice = first_choice(response)
                assistant_message = choice.get("message", {})
                content = assistant_message.get("content", "") or ""
                tool_calls = assistant_message.get("tool_calls")

                if not tool_calls:
                    tool_calls = _parse_text_tool_calls(content)
                    if tool_calls:
                        content = _strip_text_tool_calls(content)

                if not tool_calls and _needs_tool_retry(content, job.user_message):
                    if job.current_model_index < min(len(job.chain) - 1, MAX_RETRY_BUMPS):
                        # A premium money request refused without any tool call
                        # gets the finance nudge once, so the bumped model re-
                        # asks with the finance tools instead of refusing again
                        # in the same tone.
                        if (
                            premium
                            and not job.money_nudged
                            and money_intent(job.user_message)
                            and _TOOL_REFUSAL_PATTERNS.search(content)
                        ):
                            job.money_nudged = True
                            messages.append({"role": "system", "content": MONEY_NUDGE})
                        job.current_model_index += 1
                        await _safe_aclose(client)
                        client = await _build_turn_client(job)
                        continue

                # Money safety net (Part 5): the model called only task tools
                # for a money request. Nudge it once toward the finance tools
                # for premium users (free users have no finance tools - nudge
                # never fires for them) and re-ask on the paid floor model.
                if should_money_nudge(
                    premium,
                    tool_calls,
                    money_intent(job.user_message),
                    job.money_nudged,
                    job.current_model_index,
                    len(job.chain),
                ):
                    job.money_nudged = True
                    messages.append({"role": "system", "content": MONEY_NUDGE})
                    job.current_model_index += 1
                    await _safe_aclose(client)
                    client = await _build_turn_client(job)
                    continue

                if not tool_calls:
                    break

                messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                # Emit tool names AND their JSON arguments so the frontend can
                # record an undo snapshot before the tools run.
                await job.events.put((
                    "tool_start",
                    [{
                        "name": tc.get("function", {}).get("name"),
                        "arguments": tc.get("function", {}).get("arguments"),
                    } for tc in tool_calls],
                ))
                try:
                    tool_results = await execute_tool_calls(tool_calls, job.user_id, session, client)
                except Exception as tee:
                    logger.warning("tool execution failed round=%d user=%s: %s", _round, job.user_id, tee)
                    await _rollback()
                    tool_results = [{"tool_call_id": tc.get("id"), "role": "tool", "content": json.dumps({"error": f"Tool execution failed: {tee}"})} for tc in tool_calls]
                messages.extend(tool_results)
                # Commit this round's tool side-effects BEFORE the next provider
                # call: a later-round failure (provider error, model refusal)
                # must not silently roll back tasks this round already created,
                # and the model sees its own writes in the following rounds.
                await _commit()
                await job.events.put(("tool_results", [r["content"] for r in tool_results]))
                # Record what actually happened so a dropped final stream can
                # still summarize the committed work instead of a cold apology.
                for line in _extract_applied_actions(tool_results):
                    if line not in job.applied_actions:
                        job.applied_actions.append(line)
                if len(job.applied_actions) > _APPLIED_LINE_CAP:
                    del job.applied_actions[: len(job.applied_actions) - _APPLIED_LINE_CAP]

                if _round == MAX_TOOL_ROUNDS - 1:
                    fallback = await client.chat(messages, tools=None)
                    await record_usage(session, job, fallback)
                    content = (first_choice(fallback).get("message", {}).get("content", "")) or ""
                    tool_calls = None

            # Commit tool side-effects. If a failing tool left the session in a
            # rolled-back state despite execute_tool_calls' own recovery, roll
            # back and start a fresh transaction so the turn can still finish.
            try:
                if not session.is_active:
                    await _rollback()
            except Exception:
                pass
            await _commit()

            job.phase = "final"
            placeholder = await _pc(session, job.user_id, job.session_id, "assistant", "", tool_calls)
            await _commit()

            streamed = ""
            try:
                async for chunk in client.stream_chat(messages, tools=None):
                    streamed += chunk
                    await job.events.put(("token", chunk))
            except Exception as exc:
                if not streamed.strip():
                    streamed = stream_fallback_reply(
                        content, job.applied_actions, cold="Interrupted."
                    )
                    if streamed == "Interrupted.":
                        retried = await _retry_final_non_streaming(client, messages, session, job)
                        if retried:
                            streamed = retried
                    for chunk in _chunk_text(streamed):
                        await job.events.put(("token", chunk))
                placeholder.content = _normalize_reply_markdown(_strip_text_tool_calls(streamed))
                try:
                    await _commit()
                except Exception:
                    pass
                # Only surface the error when there is genuinely nothing to
                # show: a partial stream or a retried answer is the reply.
                if streamed == "Interrupted.":
                    await job.events.put(("error", _fle(exc, job.provider)))
                return

            if not streamed.strip():
                fallback = stream_fallback_reply(content, job.applied_actions)
                if not content.strip() and not job.applied_actions:
                    retried = await _retry_final_non_streaming(client, messages, session, job)
                    if retried:
                        fallback = retried
                streamed = fallback
                for chunk in _chunk_text(streamed):
                    await job.events.put(("token", chunk))

            streamed = _normalize_reply_markdown(_strip_text_tool_calls(streamed))
            placeholder.content = streamed
            try:
                await _commit()
            except Exception:
                pass

            try:
                await _reu_fn(session, job.user_id, job.provider, messages, streamed)
                try:
                    await _commit()
                except Exception:
                    pass
            except Exception:
                pass

            est = _estimate_tokens(messages, streamed)
            job.estimated_tokens = est
            await job.events.put(("usage", {"estimated_tokens": est}))

            await _mus(
                session, job.user_id, job.session_id, client,
                job.sanitized_history, job.user_message, streamed, current_summary,
            )
            await _mem(
                session, job.user_id, job.session_id, client,
                job.sanitized_history, job.user_message, streamed,
            )
            try:
                await _commit()
            except Exception:
                pass

    except Exception as exc:
        logger.warning("turn runner error user=%s: %s", job.user_id, exc)
        try:
            async with rls_session(job.user_id) as session:
                _ai_mod = _import_ai()
                error_text = _ai_mod._friendly_llm_error(exc, job.provider)
                await _ai_mod.persist_conversation(session, job.user_id, job.session_id, "assistant", error_text)
                try:
                    await session.commit()
                except Exception:
                    pass
                await job.events.put(("error", error_text))
        except Exception:
            await job.events.put(("error", "An unexpected error occurred."))
    finally:
        if client is not None:
            await _safe_aclose(client)
        job.phase = "done"
        # Preserve the explicit terminal states (cancelled after a cancel,
        # error after the recovery-persist path) instead of blanket-overwriting.
        if job.status == "running":
            job.status = "done"
        await job.events.put(("done", ""))
        job.done_event.set()
        _turns.pop(job.user_id, None)


def _import_ai():
    """Lazy import from app.routers.ai to break circular import chain."""
    import importlib
    mod = importlib.import_module("app.routers.ai")
    return mod


async def _build_turn_client(job: TurnJob):
    """Build a PrysmAI client for the current model index."""
    if job.provider == "prysmai" and job.chain:
        model = job.chain[job.current_model_index]
        fallbacks = job.chain[job.current_model_index + 1:]
        return await get_llm_client(
            job.provider,
            job.api_key,
            model=model,
            fallbacks=fallbacks,
            zdr=settings.prysm_ai_zdr,
        )
    return await get_llm_client(job.provider, job.api_key)


async def record_usage(session, job, response) -> None:
    """Record usage from a non-streaming provider response (hosted only)."""
    if job.provider != "prysmai":
        return
    from app.services.ai_entitlement import parse_usage, record_ai_usage
    u = parse_usage(response)
    if u["input"] or u["output"]:
        await record_ai_usage(session, job.user_id, "prysmai", u["input"], u["output"], u["cached_input"])


def _estimate_tokens(prompt_messages: list[dict], completion: str | None = None) -> int:
    """Rough token estimation, mirrors ai.py's _estimate_tokens."""
    _CHARS_PER_TOKEN = 4
    chars = 0
    for m in prompt_messages or []:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                fn = (tc.get("function") or {}).get("name", "")
                args = (tc.get("function") or {}).get("arguments", "")
                chars += len(fn) + len(str(args))
    prompt_tokens = max(1, chars // _CHARS_PER_TOKEN)
    if completion:
        prompt_tokens += max(0, len(completion) // _CHARS_PER_TOKEN)
    return prompt_tokens
