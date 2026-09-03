"""Watchlist business logic: metadata enrichment, upcoming refresh, serialization."""

import logging
from datetime import datetime, timezone

from app.services import tmdb_service

logger = logging.getLogger(__name__)


def serialize(item) -> dict:
    """API response shape for a watchlist item (poster URL built from the CDN)."""
    return {
        "id": str(item.id),
        "tmdb_id": item.tmdb_id,
        "media_type": item.media_type,
        "title": item.title,
        "poster_path": item.poster_path,
        "poster_url": tmdb_service.poster_url(item.poster_path),
        "release_year": item.release_year,
        "status": item.status,
        "is_theatrical": bool(item.is_theatrical),
        "rating": item.rating,
        "notes": item.notes,
        "watched_at": item.watched_at.isoformat() if item.watched_at else None,
        "upcoming": item.upcoming_json or [],
        "providers": item.providers_json or {},
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


async def fetch_and_store_metadata(session, item) -> None:
    """Populate title/poster/year/upcoming for a newly added item.

    Enriches whatever the client supplied (search result / manual entry) with
    fresh TMDB details. A no-op when TMDB is unconfigured or unreachable - the
    item keeps its manual values.
    """
    if not tmdb_service.has_key():
        return
    try:
        if item.media_type == "tv":
            details = await tmdb_service.tv_details(item.tmdb_id)
        else:
            details = await tmdb_service.movie_details(item.tmdb_id)
        if not details:
            return
        if not item.title.strip():
            item.title = details.get("name") or details.get("title") or item.title
        if not item.poster_path:
            item.poster_path = details.get("poster_path")
        if item.release_year is None:
            raw = details.get("release_date") or details.get("first_air_date")
            if raw:
                try:
                    item.release_year = int(str(raw)[:4])
                except (ValueError, TypeError):
                    pass
        item.upcoming_json = await tmdb_service.compute_upcoming(item.tmdb_id, item.media_type)
        if item.media_type == "movie":
            item.is_theatrical = await tmdb_service.has_theatrical_release(item.tmdb_id)
        item.metadata_fetched_at = datetime.now(timezone.utc)
    except Exception:
        logger.exception("watchlist metadata fetch failed for %s", item.id)


async def refresh_upcoming(session, item) -> None:
    """Recompute upcoming continuations for a stored item and stamp the fetch time."""
    if not tmdb_service.has_key():
        return
    try:
        item.upcoming_json = await tmdb_service.compute_upcoming(item.tmdb_id, item.media_type)
        if item.media_type == "movie":
            item.is_theatrical = await tmdb_service.has_theatrical_release(item.tmdb_id)
        item.metadata_fetched_at = datetime.now(timezone.utc)
    except Exception:
        logger.exception("watchlist upcoming refresh failed for %s", item.id)
