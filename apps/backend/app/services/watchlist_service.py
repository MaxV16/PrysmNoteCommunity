"""Watchlist business logic: metadata enrichment, upcoming refresh, serialization."""

import hashlib
import logging
from datetime import datetime, timezone

from app.services import tmdb_service

logger = logging.getLogger(__name__)


def synthetic_tmdb_id(media_type: str, title: str) -> int:
    """Deterministic negative id for a manual entry (no TMDB).

    Stable across runs so re-adding the same title/media_type dedupes on the
    ``(user_id, tmdb_id)`` unique constraint without a schema migration. The
    digest is trimmed to 7 hex chars so the value fits the ``Integer`` (int32)
    column: 0xFFFFFFF is below 2^31, and real TMDB ids are positive so a
    synthesized id can never collide with one.
    """
    normalized = f"{media_type}:{title.strip().lower()}"
    return -int(hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:7], 16)


def is_synthetic(tmdb_id: int) -> bool:
    """True for a manual entry (synthesized id); TMDB paths must no-op."""
    return tmdb_id < 0


async def resolve_add_identity(
    media_type: str, title: str, tmdb_id: int | None
) -> tuple[int, str, str | None, int | None]:
    """Resolve the id/title/poster/year for a new item.

    Uses the caller's ``tmdb_id`` when given; otherwise tries a TMDB title
    search and prefers a hit of the same media type; otherwise synthesizes a
    stable negative id so manual entries work with no TMDB key.
    """
    if tmdb_id is not None:
        try:
            return int(tmdb_id), title, None, None
        except (TypeError, ValueError):
            pass
    if title and tmdb_service.has_key():
        try:
            results = await tmdb_service.search_multi(title)
        except Exception:
            logger.exception("watchlist title search failed for %s", title)
            results = []
        match = next((r for r in results if r.get("media_type") == media_type), None)
        if match:
            return (
                int(match["tmdb_id"]),
                match.get("title") or title,
                match.get("poster_path"),
                match.get("release_year"),
            )
    return synthetic_tmdb_id(media_type, title), title, None, None


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
    if is_synthetic(item.tmdb_id):
        # Manual entry: no TMDB id to enrich from. Upcoming/providers no-op.
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
    if is_synthetic(item.tmdb_id):
        return
    try:
        item.upcoming_json = await tmdb_service.compute_upcoming(item.tmdb_id, item.media_type)
        if item.media_type == "movie":
            item.is_theatrical = await tmdb_service.has_theatrical_release(item.tmdb_id)
        item.metadata_fetched_at = datetime.now(timezone.utc)
    except Exception:
        logger.exception("watchlist upcoming refresh failed for %s", item.id)
