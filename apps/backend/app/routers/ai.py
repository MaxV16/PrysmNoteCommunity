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
    messages = build_messages(sanitized_history, request.message, request.context)

    response = await client.chat(messages, tools=TOOL_DEFINITIONS)

    choice = response.get("choices", [{}])[0]
    assistant_message = choice.get("message", {})
    content = assistant_message.get("content", "") or ""
    tool_calls = assistant_message.get("tool_calls")

    if tool_calls:
        messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})

        tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
        messages.extend(tool_results)

        follow_up = await client.chat(messages, tools=TOOL_DEFINITIONS)
        follow_choice = follow_up.get("choices", [{}])[0]
        content = follow_choice.get("message", {}).get("content", "") or ""

    await persist_conversation(session, user.id, session_id, "user", request.message)
    await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
    await session.commit()

    return {"content": content, "tool_calls": tool_calls}


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
    messages = build_messages(sanitized_history, request.message, request.context)

    await persist_conversation(session, user.id, session_id, "user", request.message)

    async def event_generator():
        import json

        response = await client.chat(messages, tools=TOOL_DEFINITIONS)
        choice = response.get("choices", [{}])[0]
        assistant_message = choice.get("message", {})
        content = assistant_message.get("content", "") or ""
        tool_calls = assistant_message.get("tool_calls")

        if tool_calls:
            messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})

            yield {"event": "tool_start", "data": json.dumps([tc.get("function", {}).get("name") for tc in tool_calls])}

            tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
            messages.extend(tool_results)

            yield {"event": "tool_results", "data": json.dumps([r["content"] for r in tool_results])}

            async for chunk in client.stream_chat(messages, tools=TOOL_DEFINITIONS):
                yield {"event": "token", "data": chunk}
        else:
            for word in content.split():
                yield {"event": "token", "data": word + " "}

        await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
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
    return [
        {
            "session_id": str(row[0]),
            "message_count": row[1],
            "last_message_at": row[2].isoformat(),
        }
        for row in result
    ]


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
