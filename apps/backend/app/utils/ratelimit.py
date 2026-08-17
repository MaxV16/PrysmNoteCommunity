"""Redis-backed rate limiting with an in-memory fallback.

The production/CI backend can run with or without Redis (REDIS_URL). Every
limiter here fails OPEN: if Redis is unset or unreachable, an in-memory dict
counter is used so the app (and the test suite, which has no Redis container)
keeps working. Key prefix keeps limiter namespaces separate (e.g. auth vs AI).
"""
import logging
import time

from app.config import settings

logger = logging.getLogger(__name__)

_redis_client = None
_redis_checked = False


def _get_redis():
    """Lazily build (and cache) a Redis client. Returns None when REDIS_URL is
    unset or Redis is unreachable, so callers fall back to in-memory state."""
    global _redis_client, _redis_checked
    if _redis_checked:
        return _redis_client
    _redis_checked = True
    if not settings.redis_url:
        return None
    try:
        import redis

        client = redis.Redis.from_url(
            settings.redis_url,
            socket_connect_timeout=1,
            socket_timeout=1,
            decode_responses=True,
        )
        client.ping()
        _redis_client = client
    except Exception:
        _redis_client = None
    return _redis_client


class RateLimiter:
    """Sliding-window counter + block flag, Redis-backed with dict fallback.

    ``count(key, window)`` increments and returns how many hits fall inside the
    window. ``block(key, duration)`` / ``is_blocked(key)`` implement a
    time-boxed block flag (used for the IP blocklist after repeated failures).
    """

    def __init__(self, prefix: str):
        self.prefix = prefix
        self._memory: dict[str, list[float]] = {}
        self._blocked: dict[str, float] = {}

    def count(self, key: str, window: int) -> int:
        client = _get_redis()
        if client is not None:
            rk = f"{self.prefix}:{key}"
            try:
                pipe = client.pipeline()
                pipe.incr(rk)
                # nx=True keeps the window anchored to the first hit in the burst.
                pipe.expire(rk, window, nx=True)
                return int(pipe.execute()[0])
            except Exception:
                pass
        now = time.time()
        stamps = self._memory.setdefault(key, [])
        stamps[:] = [t for t in stamps if now - t < window]
        stamps.append(now)
        return len(stamps)

    def block(self, key: str, duration: int) -> None:
        client = _get_redis()
        if client is not None:
            rk = f"{self.prefix}:block:{key}"
            try:
                client.set(rk, "1", ex=duration)
                return
            except Exception:
                pass
        self._blocked[key] = time.time() + duration

    def is_blocked(self, key: str) -> bool:
        client = _get_redis()
        if client is not None:
            rk = f"{self.prefix}:block:{key}"
            try:
                return bool(client.exists(rk))
            except Exception:
                pass
        exp = self._blocked.get(key)
        if exp is None:
            return False
        if time.time() >= exp:
            del self._blocked[key]
            return False
        return True
