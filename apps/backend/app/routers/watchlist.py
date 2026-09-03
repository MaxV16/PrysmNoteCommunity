from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.watchlist import WatchlistItem
from app.services import tmdb_service, watchlist_service
from app.utils.uuid_helpers import require_uuid

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

VALID_MEDIA_TYPES = {"movie", "tv"}
VALID_STATUSES = {"plan_to_watch", "watching", "watched"}


class WatchlistAddRequest(BaseModel):
    tmdb_id: int
    media_type: str
    # Manual-entry fallback fields; fresh TMDB metadata (when available) wins.
    title: str = ""
    release_year: int | None = None
    poster_path: str | None = None
    status: str | None = None
    rating: int | None = Field(default=None, ge=1, le=10)
    notes: str | None = None


class WatchlistUpdateRequest(BaseModel):
    status: str | None = None
    rating: int | None = Field(default=None, ge=1, le=10)
    notes: str | None = None
    watched_at: str | None = None


def _validate_add(payload: WatchlistAddRequest) -> None:
    if payload.media_type not in VALID_MEDIA_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="media_type must be movie or tv")
    if payload.status is not None and payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid status")


@router.get("/")
async def list_items(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(WatchlistItem)
        .where(WatchlistItem.user_id == user.id)
        .order_by(WatchlistItem.created_at.desc())
    )
    return [watchlist_service.serialize(i) for i in result.scalars().all()]


@router.post("/search")
async def search_tmdb(
    query: str = Query(..., max_length=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """TMDB multi-search (movie + tv). Empty list without a key or on error."""
    try:
        return await tmdb_service.search_multi(query)
    except Exception:
        # Fail-soft: a TMDB glitch must never 500 the search surface.
        return []


@router.post("/")
async def add_item(
    payload: WatchlistAddRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _validate_add(payload)
    duplicate = await session.execute(
        select(WatchlistItem.id).where(
            WatchlistItem.user_id == user.id,
            WatchlistItem.tmdb_id == payload.tmdb_id,
        )
    )
    if duplicate.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already on your watchlist")

    item = WatchlistItem(
        user_id=user.id,
        tmdb_id=payload.tmdb_id,
        media_type=payload.media_type,
        title=payload.title.strip(),
        poster_path=payload.poster_path,
        release_year=payload.release_year,
        status=payload.status or "plan_to_watch",
        rating=payload.rating,
        notes=payload.notes,
    )
    session.add(item)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already on your watchlist")

    await watchlist_service.fetch_and_store_metadata(session, item)
    if not item.title.strip():
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Title is required (TMDB lookup unavailable)",
        )
    await session.flush()
    return watchlist_service.serialize(item)


@router.patch("/{item_id}")
async def update_item(
    item_id: str,
    payload: WatchlistUpdateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(WatchlistItem).where(WatchlistItem.id == require_uuid(item_id), WatchlistItem.user_id == user.id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watchlist item not found")

    data = payload.model_dump(exclude_unset=True)
    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid status")
        item.status = data["status"]
    if "rating" in data:
        item.rating = data["rating"]
    if "notes" in data:
        item.notes = data["notes"]
    if "watched_at" in data:
        raw = data["watched_at"]
        if raw:
            try:
                item.watched_at = date.fromisoformat(raw)
            except ValueError:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="watched_at must be YYYY-MM-DD")
        else:
            item.watched_at = None
    await session.flush()
    return watchlist_service.serialize(item)


@router.delete("/{item_id}")
async def delete_item(
    item_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(WatchlistItem).where(WatchlistItem.id == require_uuid(item_id), WatchlistItem.user_id == user.id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watchlist item not found")
    await session.delete(item)
    await session.flush()
    return {"status": "deleted"}


@router.get("/{item_id}/providers")
async def get_providers(
    item_id: str,
    region: str = "US",
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Watch providers for the item's region. Fetches + caches on success; falls
    back to the cached map when TMDB is unavailable."""
    result = await session.execute(
        select(WatchlistItem).where(WatchlistItem.id == require_uuid(item_id), WatchlistItem.user_id == user.id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watchlist item not found")

    providers = await tmdb_service.watch_providers(item.tmdb_id, item.media_type, region)
    if providers is not None:
        item.providers_json = providers
        await session.flush()
    return item.providers_json or {}
