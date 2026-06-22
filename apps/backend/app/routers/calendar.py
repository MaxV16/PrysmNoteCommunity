from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.calendar_service import (
    get_google_oauth_flow,
    get_stored_tokens,
    pull_and_import_events,
    store_tokens,
    sync_all_tasks,
)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


@router.get("/auth/url")
async def get_oauth_url(redirect_uri: str = "http://localhost:3000/settings"):
    flow = get_google_oauth_flow(redirect_uri)
    auth_url, _ = flow.authorization_url(prompt="consent")
    return {"url": auth_url}


class OAuthCallbackRequest(BaseModel):
    code: str
    redirect_uri: str


@router.post("/auth/callback")
async def oauth_callback(
    request: OAuthCallbackRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    flow = get_google_oauth_flow(request.redirect_uri)
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


@router.post("/pull")
async def pull_from_calendar(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    tokens = await get_stored_tokens(session, user.id)
    if not tokens:
        raise HTTPException(status_code=400, detail="Google Calendar not connected. Authorize in Settings first.")

    access_token, refresh_token = tokens
    result = await pull_and_import_events(session, user.id, access_token, refresh_token)
    return result