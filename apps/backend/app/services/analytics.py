"""First-party, cookieless product analytics (core).

Events are pushed onto a bounded in-memory queue from the request path (never
blocking it) and flushed to ``analytics_events`` by a background loop running
through the BYPASSRLS system role. An hourly rollup loop aggregates the raw rows
into ``analytics_daily`` (kept forever) and prunes raw rows older than
``settings.analytics_retention_days``.

The queue is process-local: on a multi-worker deployment each worker flushes its
own buffered events. With the single-uvicorn-worker production stack this is
exactly right, and events are never lost to an HTTP timeout.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models.analytics_event import AnalyticsDaily, AnalyticsEvent

logger = logging.getLogger(__name__)

MAX_QUEUE_SIZE = 10_000
_MAX_PROPERTIES_BYTES = 4096
_MAX_EVENT_LENGTH = 64
_MAX_SESSION_LENGTH = 64

_event_queue: asyncio.Queue[dict[str, Any]] | None = None


def _queue() -> asyncio.Queue[dict[str, Any]]:
    global _event_queue
    if _event_queue is None:
        _event_queue = asyncio.Queue(maxsize=MAX_QUEUE_SIZE)
    return _event_queue


def _validated_event_name(event: str) -> str | None:
    event = (event or "").strip()
    if not event or len(event) > _MAX_EVENT_LENGTH:
        return None
    return event


def enqueue_event(
    user_id: str | None,
    event: str,
    properties: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> bool:
    """Append an event to the in-memory queue. Never blocks or raises on the
    request path: a full queue or oversized payload is dropped with a warning.

    ``user_id`` may be a UUID string, a raw uuid, or None (anonymous events).
    Returns True when the event was accepted.
    """
    name = _validated_event_name(event)
    if name is None:
        return False
    if properties is not None and not isinstance(properties, dict):
        return False
    props = properties if isinstance(properties, dict) else {}
    try:
        import json as _json

        if len(_json.dumps(props).encode("utf-8")) > _MAX_PROPERTIES_BYTES:
            return False
    except (TypeError, ValueError):
        return False
    sid = (session_id or "")[: _MAX_SESSION_LENGTH] or None
    # The column is Uuid(as_uuid=True): bind a real uuid object (SQLite's
    # server-default compat requires it, and it is the canonical ORM format).
    uid = None
    if user_id is not None:
        try:
            uid = UUID(str(user_id))
        except (ValueError, AttributeError):
            uid = None
    try:
        _queue().put_nowait(
            {"user_id": uid, "event": name, "properties": props, "session_id": sid}
        )
        return True
    except asyncio.QueueFull:
        logger.warning("analytics queue full; dropping event '%s'", name)
        return False


def track_event(
    session: AsyncSession | None,
    user_id: str | None,
    event: str,
    properties: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> bool:
    """Sync helper for backend callers (services, routers): enqueue an event.

    ``session`` is accepted for API symmetry with other service helpers but is
    not used: the flush loop writes through its own system session, so callers
    never need a live DB transaction just to record analytics.
    """
    return enqueue_event(user_id, event, properties, session_id)


async def flush_pending(session_factory: async_sessionmaker) -> int:
    """Drain the in-memory queue into analytics_events. Returns how many events
    were flushed. Runs through the system (BYPASSRLS) session factory so rows
    from every user can be inserted without an RLS user context."""
    batch: list[dict[str, Any]] = []
    while not _queue().empty() and len(batch) < 500:
        try:
            batch.append(_queue().get_nowait())
        except asyncio.QueueEmpty:
            break
    if not batch:
        return 0
    async with session_factory() as session:
        for item in batch:
            try:
                session.add(
                    AnalyticsEvent(
                        user_id=item.get("user_id"),
                        event=item["event"],
                        properties=item.get("properties") or {},
                        session_id=item.get("session_id"),
                    )
                )
            except Exception:
                logger.exception("analytics flush skipped an event")
        await session.commit()
    return len(batch)


async def analytics_flush_loop(session_factory: async_sessionmaker) -> None:
    """Background loop: drain the in-memory queue into analytics_events.

    Runs through the system (BYPASSRLS) session factory so rows from every user
    can be inserted without an RLS user context. One failure never aborts the
    batch: each item is attempted independently and the loop keeps running.
    """
    while True:
        try:
            await flush_pending(session_factory)
        except Exception:
            logger.exception("analytics flush loop pass failed")
        await asyncio.sleep(settings.analytics_flush_interval)


async def _rollup_day(session: AsyncSession, day: datetime) -> None:
    """Aggregate one UTC day of raw events into analytics_daily (upsert)."""
    next_day = day + timedelta(days=1)
    rows = await session.execute(
        select(
            AnalyticsEvent.event,
            func.count().label("cnt"),
            func.count(func.distinct(AnalyticsEvent.user_id)).label("users"),
        )
        .where(
            AnalyticsEvent.created_at >= day,
            AnalyticsEvent.created_at < next_day,
        )
        .group_by(AnalyticsEvent.event)
    )
    for event_name, cnt, users in rows.all():
        result = await session.execute(
            select(AnalyticsDaily).where(
                AnalyticsDaily.day == day.date(),
                AnalyticsDaily.event == event_name,
            )
        )
        daily = result.scalar_one_or_none()
        if daily is None:
            daily = AnalyticsDaily(day=day.date(), event=event_name)
            session.add(daily)
        daily.count = int(cnt)
        daily.unique_users = int(users or 0)


async def run_rollup(session_factory: async_sessionmaker) -> None:
    """Aggregate the previous UTC day into analytics_daily and prune raw rows
    past the retention window. Exposed separately so tests can drive it."""
    now = datetime.now(timezone.utc)
    day = now - timedelta(days=1)
    day = day.replace(hour=0, minute=0, second=0, microsecond=0)
    async with session_factory() as session:
        try:
            await _rollup_day(session, day)
        except Exception:
            logger.exception("analytics rollup failed for day %s", day.date())
        cutoff = now - timedelta(days=settings.analytics_retention_days)
        try:
            await session.execute(
                delete(AnalyticsEvent).where(AnalyticsEvent.created_at < cutoff)
            )
        except Exception:
            logger.exception("analytics pruning failed")
        await session.commit()


async def analytics_rollup_loop(session_factory: async_sessionmaker) -> None:
    """Background loop: hourly, aggregate the previous UTC day into
    analytics_daily and prune raw rows past the retention window."""
    while True:
        try:
            await run_rollup(session_factory)
        except Exception:
            logger.exception("analytics rollup loop pass failed")
        await asyncio.sleep(settings.analytics_rollup_interval)
