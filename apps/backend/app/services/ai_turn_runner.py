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
from sqlalchemy.ext.asyncio import AsyncSession

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
    _needs_tool_retry,
    build_messages,
    execute_tool_calls,
    get_llm_client,
    is_premium,
    tools_for_user,
)
from app.services.memory_service import retrieve_relevant_memories
from app.utils.rls import set_rls_user_id

logger = logging.getLogger("app.ai_turn_runner")

MAX_TOOL_ROUNDS = 4
MAX_RETRY_BUMPS = 2


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


_turns: dict[str, TurnJob] = {}


def get_active_turn(user_id: str) -> TurnJob | None:
    return _turns.get(user_id)


def start_turn(
    user_id: str,
    session_id: str,
    provider: str,
    api_key: str,
    chain: list[str],
    sanitized_history: list[dict],
    user_message: str,
    context: dict | None = None,
) -> TurnJob:
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

    async def _cancel_job_finish(session, job):
        """Finish cancelled turn."""
        job.status = "cancelled"
        job.phase = "done"
        job.content = "Interrupted."
        await _pc(session, job.user_id, job.session_id, "assistant", "Interrupted.")
        try:
            await session.commit()
        except Exception:
            pass

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
            if dialect == "postgresql":
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
            await session.commit()

            client = await _build_turn_client(job)
            content = ""
            tool_calls = None

            for _round in range(MAX_TOOL_ROUNDS):
                if job.cancel_requested:
                    return await _cancel_job_finish(session, job)

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
                        job.current_model_index += 1
                        await _safe_aclose(client)
                        client = await _build_turn_client(job)
                        continue

                if not tool_calls:
                    break

                messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                await job.events.put(("tool_start", [tc.get("function", {}).get("name") for tc in tool_calls]))
                tool_results = await execute_tool_calls(tool_calls, job.user_id, session, client)
                messages.extend(tool_results)
                await job.events.put(("tool_results", [r["content"] for r in tool_results]))

                if _round == MAX_TOOL_ROUNDS - 1:
                    fallback = await client.chat(messages, tools=None)
                    await record_usage(session, job, fallback)
                    content = (first_choice(fallback).get("message", {}).get("content", "")) or ""
                    tool_calls = None

            await session.commit()

            job.phase = "final"
            placeholder = await _pc(session, job.user_id, job.session_id, "assistant", "", tool_calls)
            await session.commit()

            streamed = ""
            try:
                async for chunk in client.stream_chat(messages, tools=None):
                    streamed += chunk
                    await job.events.put(("token", chunk))
            except Exception as exc:
                if not streamed.strip():
                    streamed = _strip_text_tool_calls(content).strip() or "Interrupted."
                    for chunk in _chunk_text(streamed):
                        await job.events.put(("token", chunk))
                placeholder.content = _normalize_reply_markdown(_strip_text_tool_calls(streamed))
                try:
                    await session.commit()
                except Exception:
                    pass
                await job.events.put(("error", _fle(exc, job.provider)))
                return

            if not streamed.strip():
                streamed = _strip_text_tool_calls(content).strip() or (
                    "I couldn't get a response from the AI on that turn. "
                    "Please try again or rephrase your request."
                )
                if streamed:
                    for chunk in _chunk_text(streamed):
                        await job.events.put(("token", chunk))

            streamed = _normalize_reply_markdown(_strip_text_tool_calls(streamed))
            placeholder.content = streamed
            try:
                await session.commit()
            except Exception:
                pass

            try:
                await _reu_fn(session, job.user_id, job.provider, messages, streamed)
                try:
                    await session.commit()
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
                await session.commit()
            except Exception:
                pass

    except Exception as exc:
        logger.warning("turn runner error user=%s: %s", job.user_id, exc)
        try:
            async with async_session_factory() as session:
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
        job.status = "done"
        await job.events.put(("done", ""))
        job.done_event.set()
        _turns.pop(job.user_id, None)


def _import_ai():
    """Lazy import from app.routers.ai to break circular import chain."""
    import importlib
    mod = importlib.import_module("app.routers.ai")
    return mod


async def _finish_cancelled(session: AsyncSession, job: TurnJob) -> None:
    ai = _import_ai()
    job.status = "cancelled"
    job.phase = "done"
    job.content = "Interrupted."
    await ai.persist_conversation(session, job.user_id, job.session_id, "assistant", "Interrupted.")
    try:
        await session.commit()
    except Exception:
        pass


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
