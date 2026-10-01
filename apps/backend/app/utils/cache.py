"""Small async cache-aside helper.

Backed by Redis when ``REDIS_URL`` is reachable, otherwise a bounded
in-process TTL dict (so single-worker dev and the test suite keep working with
no Redis container). Every operation is best-effort: a cache failure degrades
to a miss / no-op and must never fail a request.

The cached values are per-user read models (tags, lists, board sections) that
are invalidated explicitly on mutation. TTLs are short so a missed
invalidation can never serve stale data for long.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from app.config import settings

_redis = None
_redis_lock = asyncio.Lock()
_redis_unavailable = False

# In-process fallback: key -> (expires_at_monotonic, json_payload). Bounded and
# cleared wholesale when it grows past _MEM_MAX so it can never leak memory.
_mem: dict[str, tuple[float, str]] = {}
_mem_lock = asyncio.Lock()
_MEM_MAX = 2000


async def _get_redis():
    """Lazily connect to Redis once; return None when unavailable/disabled."""
    global _redis, _redis_unavailable
    if _redis is not None or _redis_unavailable:
        return _redis
    async with _redis_lock:
        if _redis is not None or _redis_unavailable:
            return _redis
        if not settings.redis_url:
            _redis_unavailable = True
            return None
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(
                settings.redis_url,
                socket_connect_timeout=1,
                socket_timeout=1,
                decode_responses=True,
            )
            await client.ping()
            _redis = client
        except Exception:
            _redis_unavailable = True
            _redis = None
        return _redis


def user_cache_key(resource: str, user_id: Any, *parts: str) -> str:
    suffix = ":".join(str(p) for p in parts)
    return f"cache:{resource}:{user_id}" + (f":{suffix}" if suffix else "")


async def cache_get(key: str) -> Any | None:
    try:
        client = await _get_redis()
        if client is not None:
            raw = await client.get(key)
            return json.loads(raw) if raw is not None else None
    except Exception:
        pass
    async with _mem_lock:
        item = _mem.get(key)
        if item is None:
            return None
        expires, raw = item
        if expires < time.monotonic():
            _mem.pop(key, None)
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None


async def cache_set(key: str, value: Any, ttl: int = 30) -> None:
    try:
        raw = json.dumps(value)
    except Exception:
        return
    try:
        client = await _get_redis()
        if client is not None:
            await client.set(key, raw, ex=ttl)
            return
    except Exception:
        pass
    async with _mem_lock:
        if len(_mem) >= _MEM_MAX:
            _mem.clear()
        _mem[key] = (time.monotonic() + ttl, raw)


async def cache_delete(*keys: str) -> None:
    if not keys:
        return
    try:
        client = await _get_redis()
        if client is not None:
            await client.delete(*keys)
            return
    except Exception:
        pass
    async with _mem_lock:
        for key in keys:
            _mem.pop(key, None)


async def cache_delete_prefix(prefix: str) -> None:
    try:
        client = await _get_redis()
        if client is not None:
            async for raw_key in client.scan_iter(match=f"{prefix}*", count=100):
                await client.delete(raw_key)
            return
    except Exception:
        pass
    async with _mem_lock:
        for key in [k for k in _mem if k.startswith(prefix)]:
            _mem.pop(key, None)
