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
    TOOL_DEFINITIONS,
    build_messages,
    execute_tool_calls,
    get_llm_client,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])

_ai_rate_limit: dict[str, list[float]] = {}
RATE_LIMIT_CLEANUP_INTERVAL = 300


async def _prune_rate_limits():
    while True:
        await asyncio.sleep(RATE_LIMIT_CLEANUP_INTERVAL)
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
    now = time.time()
    max_requests = 30
    window = 60

    if user_id not in _ai_rate_limit:
        _ai_rate_limit[user_id] = []
    _ai_rate_limit[user_id] = [t for t in _ai_rate_limit[user_id] if now - t < window]
    if len(_ai_rate_limit[user_id]) >= max_requests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded ({max_requests}/min). Please try again later.",
        )
    _ai_rate_limit[user_id].append(now)


MAX_CHAT_HISTORY = 20
MAX_MESSAGE_LENGTH = 4000


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
) -> None:
    conv = AiConversation(
        user_id=user_id,
        session_id=session_id,
        role=role,
        content=content,
        tool_calls=tool_calls,
    )
    session.add(conv)


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
    messages = build_messages(sanitized_history, request.message, request.context, current_summary)

    MAX_TOOL_ROUNDS = 4
    content = ""
    tool_calls = None
    for _round in range(MAX_TOOL_ROUNDS):
        response = await client.chat(messages, tools=TOOL_DEFINITIONS)
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

    await persist_conversation(session, user.id, session_id, "user", request.message)
    await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
    await _maybe_update_summary(session, user.id, session_id, client, sanitized_history, request.message, content, current_summary)
    await session.commit()

    return {"content": content, "tool_calls": tool_calls, "session_id": session_id}


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
    messages = build_messages(sanitized_history, request.message, request.context, current_summary)

    await persist_conversation(session, user.id, session_id, "user", request.message)

    async def event_generator():
        import json

        MAX_TOOL_ROUNDS = 4
        tool_calls = None
        content = ""

        for _round in range(MAX_TOOL_ROUNDS):
            response = await client.chat(messages, tools=TOOL_DEFINITIONS)
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

            if _round == MAX_TOOL_ROUNDS - 1:
                fallback = await client.chat(messages, tools=None)
                content = (fallback.get("choices", [{}])[0].get("message", {}).get("content", "")) or ""

        # Stream the final natural-language answer.
        if content:
            async for chunk in client.stream_chat(messages, tools=TOOL_DEFINITIONS):
                yield {"event": "token", "data": chunk}
        else:
            yield {"event": "token", "data": " "}

        await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
        await _maybe_update_summary(
            session, user.id, session_id, client, sanitized_history, request.message, content, current_summary
        )
        await session.commit()
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
    await session.commit()
    return {"deleted": True, "session_id": session_id}
