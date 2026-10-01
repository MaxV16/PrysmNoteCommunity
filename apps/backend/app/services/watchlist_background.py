"""Background loop that keeps watchlist upcoming-continuation data fresh.

Runs every ~6h. Lists items needing a refresh in one short system session (never
held open across network calls), then refreshes each in its own session with a
bounded semaphore, so one slow/failing TMDB call can never stall the loop or the
rest of the batch. Skips entirely when no TMDB key is configured.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app.config import settings
from app.models.watchlist import WatchlistItem
from app.services import watchlist_service

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_SECONDS = 6 * 3600
REFRESH_CONCURRENCY = 3


async def refresh_due_items(session_factory) -> int:
    """One refresh pass: recompute upcoming data for every stale item.

    Returns how many items refreshed. Lists the due ids in one short session
    (never held open across network calls), then refreshes each in its own
    session under a bounded semaphore; one failing item never aborts the batch.
    """
    if not settings.tmdb_api_key:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=REFRESH_INTERVAL_SECONDS)
    async with session_factory() as session:
        # Filter the due check in SQL so the query returns only the stale items
        # instead of loading every row's timestamp and filtering in Python.
        result = await session.execute(
            select(WatchlistItem.id).where(
                or_(
                    WatchlistItem.metadata_fetched_at.is_(None),
                    WatchlistItem.metadata_fetched_at < cutoff,
                )
            )
        )
        due_ids = [row[0] for row in result.all()]

    refreshed = 0
    semaphore = asyncio.Semaphore(REFRESH_CONCURRENCY)

    async def _refresh_item(item_id):
        nonlocal refreshed
        async with semaphore:
            try:
                async with session_factory() as session:
                    result = await session.execute(
                        select(WatchlistItem).where(WatchlistItem.id == item_id)
                    )
                    item = result.scalar_one_or_none()
                    if item is None:
                        return
                    await watchlist_service.refresh_upcoming(session, item)
                    await session.commit()
                    refreshed += 1
            except Exception:
                pass

    if due_ids:
        await asyncio.gather(*(_refresh_item(iid) for iid in due_ids))
    return refreshed


async def watchlist_background_loop(session_factory):
    while True:
        try:
            await refresh_due_items(session_factory)
        except Exception as e:
            logger.warning("watchlist background refresh error: %s", e)
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
