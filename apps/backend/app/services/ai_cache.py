"""Response-cache helpers for deterministic tool-round LLM calls (core).

``cache_key`` is a sha256 of the exact request (provider + messages + tools), so
a hit is only ever served for byte-identical input. TTL is short (5 min) to bound
staleness. Only used for the non-streaming tool rounds; the final user-facing
answer is never cached.
"""
import hashlib
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_cache import AiCache

CACHE_TTL_SECONDS = 300


def make_cache_key(user_id, provider: str, messages: list[dict], tools: list[dict] | None, model: str | None = None) -> str:
    payload = json.dumps(
        [str(user_id), provider, model, messages, tools], sort_keys=True, default=str
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def get_cached_response(session: AsyncSession, user_id, provider: str, messages: list[dict], tools: list[dict] | None, model: str | None = None):
    """Return a cached response dict for the exact request, or None."""
    key = make_cache_key(user_id, provider, messages, tools, model)
    now = datetime.now(timezone.utc)
    result = await session.execute(
        select(AiCache).where(
            AiCache.user_id == user_id,
            AiCache.provider == provider,
            AiCache.cache_key == key,
            AiCache.expires_at > now,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        return None
    try:
        return json.loads(row.response)
    except (json.JSONDecodeError, TypeError):
        return None


async def cache_response(session: AsyncSession, user_id, provider: str, messages: list[dict], tools: list[dict] | None, response: dict, model: str | None = None) -> None:
    """Store an exact-match cache entry (best-effort, never raises)."""
    try:
        key = make_cache_key(user_id, provider, messages, tools, model)
        now = datetime.now(timezone.utc)
        session.add(
            AiCache(
                user_id=user_id,
                provider=provider,
                cache_key=key,
                response=json.dumps(response),
                expires_at=now + timedelta(seconds=CACHE_TTL_SECONDS),
            )
        )
    except Exception:
        pass


async def purge_expired(session: AsyncSession, user_id, provider: str) -> None:
    """Best-effort cleanup of expired cache rows for a user (cheap)."""
    try:
        await session.execute(
            delete(AiCache).where(
                AiCache.user_id == user_id,
                AiCache.provider == provider,
                AiCache.expires_at <= datetime.now(timezone.utc),
            )
        )
    except Exception:
        pass
