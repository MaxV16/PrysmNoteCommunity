import asyncio
from uuid import uuid4
import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.ai_conversation import AiConversation
from app.models.ai_session import AiSession
from app.models.api_key import ApiKey
from app.models.user import User
from app.services.ai_service import (
    build_messages,
    execute_tool_calls,
    get_llm_client,
    is_premium,
    tools_for_user,
)
from app.services.memory_service import (
    extract_memories,
    list_active_memories,
    purge_memories_for_session,
    retrieve_relevant_memories,
    store_memories,
)
from app.utils.ratelimit import RateLimiter, _get_redis

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Redis-backed per-user limiter (rl:ai:* keys) with an in-memory fallback (used
# by tests and any deployment without Redis). The TTL pruner below only matters
# for the fallback; Redis entries expire on their own.
_ai_limiter = RateLimiter("rl:ai")
_ai_rate_limit: dict[str, list[float]] = {}
RATE_LIMIT_CLEANUP_INTERVAL = 300


async def _prune_rate_limits():
    while True:
        await asyncio.sleep(RATE_LIMIT_CLEANUP_INTERVAL)
        if _get_redis() is not None:
            # Redis TTLs expire counters automatically — nothing to prune.
            continue
        now = time.time()
        stale = [uid for uid, stamps in _ai_rate_limit.items()
                 if not any(now - t < 60 for t in stamps)]
        for uid in stale:
            del _ai_rate_limit[uid]
        for stamps in _ai_rate_limit.values():
            stamps[:] = [t for t in stamps if now - t < 60]


def start_rate_limit_pruner() -> asyncio.Task:
    return asyncio.create_task(_prune_rate_limits())


def _check_ai_rate_limit(user_id: str) -> None:
    max_requests = 30
    window = 60

    if _get_redis() is not None:
        count = _ai_limiter.count(f"ai:{user_id}", window)
        if count > max_requests:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({max_requests}/min). Please try again later.",
            )
        return

    now = time.time()
    if user_id not in _ai_rate_limit:
        _ai_rate_limit[user_id] = []
    _ai_rate_limit[user_id] = [t for t in _ai_rate_limit[user_id] if now - t < window]
    if len(_ai_rate_limit[user_id]) >= max_requests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded ({max_requests}/min). Please try again later.",
        )
    _ai_rate_limit[user_id].append(now)


def _provider_error_detail(exc: Exception) -> str | None:
    """Return the underlying provider error message (e.g. OpenRouter's
    'Insufficient Credits') when we can read it, else None."""
    import openai

    if isinstance(exc, openai.APIStatusError):
        body = exc.body
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                return str(err.get("message", "")).strip() or None
            if isinstance(err, str) and err.strip():
                return err.strip() or None
        return str(exc)
    if isinstance(exc, openai.OpenAIError):
        return str(getattr(exc, "message", exc)).strip() or None
    return None


def _friendly_llm_error(exc: Exception) -> str:
    """Map provider/transport errors to a clear, actionable user message — e.g.
    when the user's OpenRouter key has no credits left."""
    import openai

    if isinstance(exc, openai.AuthenticationError):
        return "Your AI API key was rejected by the provider. Check the key in Settings."
    if isinstance(exc, openai.RateLimitError):
        return "The AI provider is rate-limiting requests. Please wait a moment and try again."

    detail = (_provider_error_detail(exc) or "").lower()
    status = exc.status_code if isinstance(exc, openai.APIStatusError) else None

    if status == 402 or "insufficient credit" in detail or "no credit" in detail or "payment required" in detail:
        return (
            "Your AI provider account is out of credits, so the AI can't respond. "
            "Top up your account (e.g. at openrouter.ai) and try again."
        )
    if status and status == 429:
        return "The AI provider is rate-limiting requests. Please wait a moment and try again."

    if status:
        msg = _provider_error_detail(exc) or ""
        return f"The AI provider returned an error (HTTP {status}).{(' ' + msg) if msg else ''}"
    if isinstance(exc, openai.APIConnectionError):
        return "Could not reach the AI provider. Check your internet connection and try again."
    msg = str(exc).strip()
    return f"AI request failed.{(' ' + msg) if msg else ''}"


MAX_CHAT_HISTORY = 20
MAX_MESSAGE_LENGTH = 4000


def _chunk_text(text: str, size: int = 400) -> list[str]:
    """Split already-computed final answer text into token-like chunks so the
    frontend can render it incrementally without a second model call."""
    text = text or ""
    if len(text) <= size:
        return [text]
    words = text.split(" ")
    chunks: list[str] = []
    cur = ""
    for w in words:
        if cur and len(cur) + len(w) + 1 > size:
            chunks.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip() if cur else w
    if cur:
        chunks.append(cur)
    return chunks


# Rough heuristic: ~4 chars per token, close enough for cost-usage visibility.
_CHARS_PER_TOKEN = 4


def _estimate_tokens(prompt_messages: list[dict], completion: str | None = None) -> int:
    """Estimate total tokens for a prompt + (optional) completion, so the user
    can see how expensive a turn was. Not a precise tokenizer — for visibility."""
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


def _sanitize_chat_history(chat_history: list[dict]) -> list[dict]:
    sanitized_history = []
    for msg in chat_history[-MAX_CHAT_HISTORY:]:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue
        content = str(msg.get("content", ""))[:MAX_MESSAGE_LENGTH]
        sanitized_history.append({"role": role, "content": content})
    return sanitized_history


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    chat_history: list[dict] = []
    provider: str = "openai"
    context: dict | None = None


async def get_user_api_key(session: AsyncSession, user: User, provider: str) -> str | None:
    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user.id,
            ApiKey.provider == provider,
            ApiKey.is_active.is_(True),
        )
    )
    api_key = result.scalar_one_or_none()
    if api_key:
        from app.utils.encryption import decrypt_api_key
        return decrypt_api_key(api_key.encrypted_key)
    return None


async def persist_conversation(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    role: str,
    content: str,
    tool_calls: dict | None = None,
) -> AiConversation:
    conv = AiConversation(
        user_id=user_id,
        session_id=session_id,
        role=role,
        content=content,
        tool_calls=tool_calls,
    )
    session.add(conv)
    return conv


async def load_session_summary(session: AsyncSession, user_id: str, session_id: str) -> AiSession | None:
    result = await session.execute(
        select(AiSession).where(
            AiSession.user_id == user_id,
            AiSession.session_id == session_id,
        )
    )
    return result.scalar_one_or_none()


async def create_session_summary(session: AsyncSession, user_id: str, session_id: str) -> None:
    session.add(AiSession(user_id=user_id, session_id=session_id))


async def summarize_conversation(
    client,
    history: list[dict],
    existing_summary: str | None,
) -> str:
    prior = f"\nExisting summary:\n{existing_summary}" if existing_summary else ""
    transcript = "\n".join(
        f"{m.get('role')}: {str(m.get('content', ''))[:800]}"
        for m in history[-20:]
        if m.get("role") in ("user", "assistant", "tool")
    )
    prompt = (
        "You maintain a compact rolling summary of a task-management chat. "
        "Distill the ABSOLUTE essentials only: tasks discussed or created (title, date, priority), "
        "scheduling decisions, conflicts, dates resolved, and user preferences. "
        "Keep it to one concise paragraph (under ~120 words). "
        "Do NOT invent facts not in the conversation. Drop trivia.\n\n"
        f"{prior.strip()}\n\nLatest messages:\n{transcript.strip()}\n\n"
        "Updated one-paragraph summary:"
    )
    try:
        resp = await client.chat(
            [{"role": "user", "content": prompt}],
            tools=None,
            temperature=0.2,
            max_tokens=300,
        )
        content = (resp.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()
        if not content or len(content) < 20:
            return existing_summary or ""
        # Collapse the "Updated ..." wrapper if the model echoed it.
        return content
    except Exception:
        return existing_summary or ""


SUMMARIZE_MIN_HISTORY = 8


async def _maybe_update_summary(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    client,
    sanitized_history: list[dict],
    user_message: str,
    assistant_content: str,
    current_summary: str | None,
) -> None:
    """Fold the latest turns into a rolling summary.

    Only runs once there's enough history for a summary to be useful, or when a
    summary already exists (so it keeps evolving). Failures fall back silently to
    the existing truncation behavior — never breaks the user request.
    """
    total_turns = len(sanitized_history) + 2  # + this user + assistant message
    if total_turns < SUMMARIZE_MIN_HISTORY and not current_summary:
        return

    combined_history = sanitized_history + [
        {"role": "user", "content": user_message},
        {"role": "assistant", "content": assistant_content},
    ]
    new_summary = await summarize_conversation(client, combined_history, current_summary)

    ai_session = await load_session_summary(session, user_id, session_id)
    if ai_session is None:
        await create_session_summary(session, user_id, session_id)
        ai_session = await load_session_summary(session, user_id, session_id)
    if ai_session is not None:
        ai_session.summary = new_summary
    await session.flush()


# Run memory extraction only when the turn plausibly produced something durable
# (a real assistant reply, or it replaced placeholder content when tools ran).
MEMORY_EXTRACT_MIN_CONTENT = 20


async def _maybe_extract_memories(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    client,
    sanitized_history: list[dict],
    user_message: str,
    assistant_content: str,
) -> list[dict]:
    """After a turn, distill any durable cross-session facts into AiMemory rows.

    Fail-open and bounded (mirrors _maybe_update_summary): never raises into the
    turn, caps storage, dedupes. Only runs when there's a substantive reply and
    either meaningful history or the user actually wrote something new.
    """
    if not assistant_content or len(assistant_content) < MEMORY_EXTRACT_MIN_CONTENT:
        return []
    if not (user_message.strip() or sanitized_history):
        return []

    facts = await extract_memories(client, sanitized_history, user_message, assistant_content)
    if not facts:
        return facts
    await store_memories(session, user_id, session_id, facts)
    return facts


@router.post("/chat")
async def chat(
    request: ChatRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _check_ai_rate_limit(str(user.id))

    api_key = await get_user_api_key(session, user, request.provider)
    if not api_key:
        raise HTTPException(status_code=400, detail="Please provide an API key in Settings.")

    session_id = request.session_id or str(uuid4())
    client = await get_llm_client(request.provider, api_key)
    sanitized_history = _sanitize_chat_history(request.chat_history)
    ai_session = await load_session_summary(session, user.id, session_id)
    current_summary = ai_session.summary if ai_session else None
    memories = await retrieve_relevant_memories(session, str(user.id), request.message)
    premium = await is_premium(str(user.id), session)
    tools = tools_for_user(premium)
    messages = build_messages(sanitized_history, request.message, request.context, current_summary, memories, include_finance=premium)

    MAX_TOOL_ROUNDS = 4
    content = ""
    tool_calls = None
    try:
        for _round in range(MAX_TOOL_ROUNDS):
            response = await client.chat(messages, tools=tools)
            choice = response.get("choices", [{}])[0]
            assistant_message = choice.get("message", {})
            content = assistant_message.get("content", "") or ""
            tool_calls = assistant_message.get("tool_calls")

            if not tool_calls:
                break

            messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
            tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
            messages.extend(tool_results)

            if _round == MAX_TOOL_ROUNDS - 1:
                fallback = await client.chat(messages, tools=None)
                content = (fallback.get("choices", [{}])[0].get("message", {}).get("content", "")) or ""
                tool_calls = None
    except Exception as exc:  # provider/auth/credit errors -> a clear, actionable message
        raise HTTPException(status_code=502, detail=_friendly_llm_error(exc)) from exc

    # Durable tool side-effects before answering: commit any created/scheduled
    # tasks so a disconnect after the response can't roll them back.
    await session.commit()

    await persist_conversation(session, user.id, session_id, "user", request.message)
    await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
    await _maybe_update_summary(session, user.id, session_id, client, sanitized_history, request.message, content, current_summary)
    await _maybe_extract_memories(session, user.id, session_id, client, sanitized_history, request.message, content)
    await session.commit()

    return {
        "content": content,
        "tool_calls": tool_calls,
        "session_id": session_id,
        "estimated_tokens": _estimate_tokens(messages, content),
    }


@router.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _check_ai_rate_limit(str(user.id))

    api_key = await get_user_api_key(session, user, request.provider)
    if not api_key:
        raise HTTPException(status_code=400, detail="Please provide an API key in Settings.")

    session_id = request.session_id or str(uuid4())
    client = await get_llm_client(request.provider, api_key)
    sanitized_history = _sanitize_chat_history(request.chat_history)
    ai_session = await load_session_summary(session, user.id, session_id)
    current_summary = ai_session.summary if ai_session else None
    memories = await retrieve_relevant_memories(session, str(user.id), request.message)
    premium = await is_premium(str(user.id), session)
    tools = tools_for_user(premium)
    messages = build_messages(sanitized_history, request.message, request.context, current_summary, memories, include_finance=premium)

    await persist_conversation(session, user.id, session_id, "user", request.message)

    async def event_generator():
        import json

        MAX_TOOL_ROUNDS = 4
        tool_calls = None
        content = ""

        try:
            for _round in range(MAX_TOOL_ROUNDS):
                response = await client.chat(messages, tools=tools)
                choice = response.get("choices", [{}])[0]
                assistant_message = choice.get("message", {})
                content = assistant_message.get("content", "") or ""
                tool_calls = assistant_message.get("tool_calls")

                if not tool_calls:
                    break

                # Run tool calls, feed their outputs back, and continue the loop so a
                # search → create → conflict-check sequence can complete in one turn.
                messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                yield {
                    "event": "tool_start",
                    "data": json.dumps([tc.get("function", {}).get("name") for tc in tool_calls]),
                }
                tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
                messages.extend(tool_results)
                yield {"event": "tool_results", "data": json.dumps([r["content"] for r in tool_results])}
        except Exception as exc:  # provider/auth/credit errors should be visible, not a dead stream
            yield {"event": "error", "data": _friendly_llm_error(exc)}
            return

        # Commit tool side-effects, the user message (persisted at request time)
        # AND an assistant placeholder BEFORE streaming the final answer.
        # Persisting the assistant turn here — instead of after the tokens stream
        # — means a client abort/cancel mid-answer can never drop the reply: once
        # we reach this point the whole turn is durable. Tool-created tasks are
        # flushed in execute_tool_calls but not committed; this commit makes them
        # durable too.
        placeholder = await persist_conversation(session, user.id, session_id, "assistant", "", tool_calls)
        await session.commit()

        # Stream the final natural-language answer for real. The tool loop's
        # completed content is only a fallback; the final round re-invokes the
        # provider in streaming mode so tokens arrive incrementally (the cost of
        # one extra model call per turn is accepted).
        streamed = ""
        try:
            async for chunk in client.stream_chat(messages, tools=None):
                streamed += chunk
                yield {"event": "token", "data": chunk}
        except Exception as exc:
            # Fall back to the non-streaming loop output rather than an empty
            # answer, then surface the error so the client can show it.
            if streamed:
                yield {"event": "error", "data": _friendly_llm_error(exc)}
                return
            streamed = content
            for chunk in _chunk_text(streamed):
                yield {"event": "token", "data": chunk}
            yield {"event": "error", "data": _friendly_llm_error(exc)}
            return

        if not streamed:
            streamed = content or " "
            for chunk in _chunk_text(streamed):
                yield {"event": "token", "data": chunk}

        # Persist the streamed answer over the placeholder row.
        placeholder.content = streamed
        await session.commit()

        estimated_tokens = _estimate_tokens(messages, streamed)
        yield {"event": "usage", "data": json.dumps({"estimated_tokens": estimated_tokens})}

        # Summary/memory distillation are best-effort and must never lose the
        # already-committed conversation — isolate them so a failure can't tear
        # down the SSE stream or roll anything back.
        try:
            await _maybe_update_summary(
                session, user.id, session_id, client, sanitized_history, request.message, streamed, current_summary
            )
            await _maybe_extract_memories(session, user.id, session_id, client, sanitized_history, request.message, streamed)
            await session.commit()
        except Exception:
            pass
        yield {"event": "done", "data": ""}

    return EventSourceResponse(event_generator())


@router.get("/sessions")
async def list_sessions(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func as sa_func
    result = await session.execute(
        select(AiConversation.session_id, sa_func.count(AiConversation.id), sa_func.max(AiConversation.created_at))
        .where(AiConversation.user_id == user.id)
        .group_by(AiConversation.session_id)
        .order_by(sa_func.max(AiConversation.created_at).desc())
        .limit(50)
    )
    rows = result.all()

    titles: dict[str, str] = {}
    summ: dict[str, str | None] = {}
    if rows:
        ids = [str(r[0]) for r in rows]
        first_msgs = await session.execute(
            select(AiConversation)
            .where(
                AiConversation.user_id == user.id,
                AiConversation.session_id.in_(ids),
                AiConversation.role == "user",
            )
            .order_by(AiConversation.created_at)
        )
        seen: set[str] = set()
        for c in first_msgs.scalars().all():
            sid = str(c.session_id)
            if sid in seen:
                continue
            seen.add(sid)
            titles[sid] = (c.content or "").strip()[:60] or "New Chat"

        summaries = await session.execute(
            select(AiSession).where(AiSession.user_id == user.id, AiSession.session_id.in_(ids))
        )
        summ = {str(s.session_id): s.summary for s in summaries.scalars().all()}

    out = []
    for (sid, count, last_at) in rows:
        sid = str(sid)
        out.append({
            "session_id": sid,
            "title": titles.get(sid) or "New Chat",
            "message_count": count,
            "last_message_at": last_at.isoformat(),
            "summary": summ.get(sid),
        })
    return out


@router.get("/conversations/{session_id}")
async def get_conversation_history(
    session_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(AiConversation)
        .where(
            AiConversation.user_id == user.id,
            AiConversation.session_id == session_id,
        )
        .order_by(AiConversation.created_at)
    )
    return [
        {
            "role": c.role,
            "content": c.content,
            "tool_calls": c.tool_calls,
            "created_at": c.created_at.isoformat(),
        }
        for c in result.scalars().all()
    ]


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import delete
    await session.execute(
        delete(AiSession).where(
            AiSession.user_id == user.id,
            AiSession.session_id == session_id,
        )
    )
    await session.execute(
        delete(AiConversation).where(
            AiConversation.user_id == user.id,
            AiConversation.session_id == session_id,
        )
    )
    # Purge any durable memory facts extracted from this session so deleting a
    # chat also drops the "life" facts it produced.
    await purge_memories_for_session(session, str(user.id), session_id)
    await session.commit()
    return {"deleted": True, "session_id": session_id}


@router.get("/memories")
async def get_memories(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    memories = await list_active_memories(session, str(user.id))
    return memories


@router.delete("/memories/{memory_id}")
async def delete_memory(
    memory_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import delete
    from app.models.ai_memory import AiMemory
    result = await session.execute(
        delete(AiMemory).where(
            AiMemory.user_id == user.id,
            AiMemory.id == memory_id,
        )
    )
    await session.commit()
    return {"deleted": bool(result.rowcount), "memory_id": memory_id}
