import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.user_token import UserToken
from app.services.calendar_service import (
    get_google_oauth_flow,
    get_stored_tokens,
    pull_and_import_events,
    store_tokens,
    sync_all_tasks,
)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# Cookie name carrying the OAuth state issued by GET /auth/url (M8). Validated
# on the callback so a forged/CSRF-driven callback can't bind an authorization
# code to the victim's account.
_CALENDAR_STATE_COOKIE = "calendar_oauth_state"


def _calendar_redirect_uri() -> str:
    """Server-configured OAuth redirect target for the calendar flow.

    Never take a client-supplied redirect_uri: the browser returns to this
    exact URL after Google consent, so an attacker-controlled value would be an
    open-redirect / code-interception vector.
    """
    return settings.calendar_redirect_uri or f"{settings.app_origin}/settings"


def _decrypt_pair(token: UserToken) -> tuple[str, str]:
    from app.services.calendar_service import _decrypt_token

    return _decrypt_token(token.access_token), _decrypt_token(token.refresh_token or "") or ""


@router.get("/auth/url")
async def get_oauth_url(request: Request, response: Response):
    redirect_uri = _calendar_redirect_uri()
    state = secrets.token_urlsafe(24)
    flow = get_google_oauth_flow(redirect_uri)
    auth_url, _ = flow.authorization_url(state=state, prompt="consent")
    response.set_cookie(
        _CALENDAR_STATE_COOKIE,
        state,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
        max_age=600,
    )
    return {"url": auth_url, "redirect_uri": redirect_uri}


class OAuthCallbackRequest(BaseModel):
    code: str
    state: str = ""
    redirect_uri: str = ""


@router.post("/auth/callback")
async def oauth_callback(
    request: OAuthCallbackRequest,
    req: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if request.redirect_uri and request.redirect_uri != _calendar_redirect_uri():
        raise HTTPException(status_code=400, detail="redirect_uri mismatch")
    expected_state = req.cookies.get(_CALENDAR_STATE_COOKIE)
    if not expected_state or not secrets.compare_digest(expected_state, request.state or ""):
        raise HTTPException(status_code=400, detail="OAuth state mismatch")

    flow = get_google_oauth_flow(_calendar_redirect_uri())
    flow.fetch_token(code=request.code)
    credentials = flow.credentials

    await store_tokens(
        session,
        user.id,
        credentials.token,
        credentials.refresh_token,
        credentials.expiry,
    )

    return {
        "status": "success",
        "email": getattr(credentials, "id_token", {}).get("email", ""),
    }


@router.post("/sync")
async def sync_calendar(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    tokens = await get_stored_tokens(session, user.id)
    if not tokens:
        raise HTTPException(status_code=400, detail="Google Calendar not connected. Authorize in Settings first.")

    access_token, refresh_token = tokens
    result = await sync_all_tasks(session, user.id, access_token, refresh_token)
    return result


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
