"""Per-user event bus for SSE push (Phase B).

Publishes lightweight change notifications to a per-user channel so the frontend
can refetch only what changed instead of polling on a fixed interval. Uses Redis
pub/sub when ``REDIS_URL`` is configured (works across the 2 uvicorn workers) and
an in-process asyncio fan-out fallback otherwise (tests, single-worker dev).

Design notes:
- ``notify_user_event`` is synchronous and fire-and-forget: it schedules the
  publish on the running loop so request handlers never block on Redis.
- Publishing never raises; a broken Redis degrades to the in-process fallback.
"""
import asyncio
import json
import logging
from collections import defaultdict

from app.config import settings

logger = logging.getLogger(__name__)

CHANNEL_PREFIX = "prysm:events:"

_async_redis = None
_redis_checked = False
_redis_lock = asyncio.Lock()

# In-process fallback: user_id -> set of asyncio.Queue
_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)

# Keep strong refs to in-flight publish tasks so they are not GC'd.
_pending_tasks: set[asyncio.Task] = set()


def _channel(user_id) -> str:
    return f"{CHANNEL_PREFIX}{user_id}"


async def _get_async_redis():
    """Lazily build (and cache) an async Redis client, or None when unavailable."""
    global _async_redis, _redis_checked
    if _redis_checked:
        return _async_redis
    async with _redis_lock:
        if _redis_checked:
            return _async_redis
        if not settings.redis_url:
            _redis_checked = True
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
            _async_redis = client
        except Exception:
            _async_redis = None
        _redis_checked = True
    return _async_redis


async def publish_user_event(user_id, resource: str, ids: list[str] | None = None) -> None:
    """Notify that a user's ``resource`` changed. Never raises."""
    payload = json.dumps({"resource": resource, "ids": list(ids or [])})
    client = await _get_async_redis()
    if client is not None:
        try:
            await client.publish(_channel(user_id), payload)
            return
        except Exception:
            logger.debug("SSE publish via Redis failed; using in-process fan-out", exc_info=True)
    for queue in list(_subscribers.get(str(user_id), ())):
        try:
            queue.put_nowait(payload)
        except Exception:
            pass


def notify_user_event(user_id, resource: str, ids: list[str] | None = None) -> None:
    """Schedule a publish without blocking the caller (fire-and-forget)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(publish_user_event(user_id, resource, ids))
    _pending_tasks.add(task)
    task.add_done_callback(_pending_tasks.discard)


async def subscribe_user_events(user_id):
    """Yield event payload strings for a user; yields None on heartbeat timeout."""
    client = await _get_async_redis()
    if client is not None:
        pubsub = client.pubsub()
        await pubsub.subscribe(_channel(user_id))
        try:
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=15
                )
                if message is None:
                    yield None
                else:
                    data = message.get("data")
                    yield data if isinstance(data, str) else None
        finally:
            try:
                await pubsub.unsubscribe(_channel(user_id))
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                try:
                    await pubsub.close()
                except Exception:
                    pass
        return

    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    key = str(user_id)
    _subscribers[key].add(queue)
    try:
        while True:
            try:
                yield await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield None
    finally:
        _subscribers[key].discard(queue)
        if not _subscribers[key]:
            _subscribers.pop(key, None)
