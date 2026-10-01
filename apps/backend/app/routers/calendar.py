from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.user_token import UserToken
from app.services.calendar_service import pull_and_import_events

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


def _decrypt_pair(token: UserToken) -> tuple[str, str]:
    from app.services.calendar_service import _decrypt_token

    return _decrypt_token(token.access_token), _decrypt_token(token.refresh_token or "") or ""


@router.get("/status")
async def calendar_status(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.provider == "google_calendar",
        )
    )
    token = result.scalar_one_or_none()
    if not token or not token.access_token:
        return {"connected": False, "last_synced_at": None}
    return {
        "connected": True,
        "last_synced_at": token.last_pulled_at.isoformat() if token.last_pulled_at else None,
    }


@router.post("/pull")
async def pull_from_calendar(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.provider == "google_calendar",
        )
    )
    token = result.scalar_one_or_none()
    if not token or not token.access_token:
        raise HTTPException(status_code=400, detail="Google Calendar not connected. Authorize in Settings first.")

    if token.last_pulled_at:
        # SQLite returns naive datetimes for TIMESTAMPTZ columns; treat them as UTC.
        last_pulled = token.last_pulled_at
        if last_pulled.tzinfo is None:
            last_pulled = last_pulled.replace(tzinfo=timezone.utc)
        elapsed = (datetime.now(timezone.utc) - last_pulled).total_seconds()
        if elapsed < settings.calendar_manual_sync_min_interval:
            remaining = max(1, int(settings.calendar_manual_sync_min_interval - elapsed))
            raise HTTPException(
                status_code=429,
                detail=f"Calendar synced recently. Try again in {remaining}s.",
            )

    access_token, refresh_token = _decrypt_pair(token)
    result = await pull_and_import_events(session, user.id, access_token, refresh_token)
    token.last_pulled_at = datetime.now(timezone.utc)
    return result
