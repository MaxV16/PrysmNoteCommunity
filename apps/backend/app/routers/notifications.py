from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.notifications import PushSubscription, UserNotificationPrefs
from app.models.user import User
from app.services.notification_service import get_or_create_prefs, _push_to_user
from app.services.email import send_email

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class UpdatePrefsRequest(BaseModel):
    email_reminders: Optional[bool] = None
    due_alerts: Optional[bool] = None
    email_digest: Optional[bool] = None
    push_enabled: Optional[bool] = None
    sound: Optional[bool] = None


class SubscribeRequest(BaseModel):
    endpoint: str
    p256dh: str
    auth: str


# Push service hosts the notification loop may POST to. The subscription
# endpoint is stored from the browser's PushManager and must be a real Web Push
# service (FCM / Mozilla autopush / Apple). Validating https + host here closes
# the blind-SSRF where an attacker registers an arbitrary internal/metadata URL
# (M2) and the loop fires VAPID-signed POSTs at it.
ALLOWED_PUSH_HOSTS = {
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
}


def _validate_push_endpoint(endpoint: str) -> str:
    from urllib.parse import urlparse

    try:
        parsed = urlparse(endpoint)
    except ValueError:
        parsed = None
    if parsed is None or parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Push endpoint must be an https URL")
    host = parsed.hostname.lower()
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in ALLOWED_PUSH_HOSTS):
        raise HTTPException(status_code=400, detail="Push endpoint host is not a supported push service")
    return endpoint


def _prefs_dict(prefs: UserNotificationPrefs) -> dict:
    return {
        "email_reminders": prefs.email_reminders,
        "due_alerts": prefs.due_alerts,
        "email_digest": prefs.email_digest,
        "push_enabled": prefs.push_enabled,
        "sound": prefs.sound,
    }


@router.get("/prefs")
async def get_prefs(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    prefs = await get_or_create_prefs(session, user.id)
    await session.commit()
    return _prefs_dict(prefs)


@router.patch("/prefs")
async def update_prefs(
    request: UpdatePrefsRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    prefs = await get_or_create_prefs(session, user.id)
    for field in ("email_reminders", "due_alerts", "email_digest", "push_enabled", "sound"):
        value = getattr(request, field)
        if value is not None:
            setattr(prefs, field, value)
    await session.commit()
    return _prefs_dict(prefs)


@router.get("/vapid-public-key")
async def get_vapid_public_key():
    return {"public_key": settings.vapid_public_key}


@router.post("/subscribe")
async def subscribe(
    request: SubscribeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _validate_push_endpoint(request.endpoint)
    existing = await session.execute(
        select(PushSubscription).where(PushSubscription.endpoint == request.endpoint)
    )
    sub = existing.scalar_one_or_none()
    if sub:
        sub.user_id = user.id
        sub.p256dh = request.p256dh
        sub.auth = request.auth
    else:
        session.add(
            PushSubscription(
                user_id=user.id,
                endpoint=request.endpoint,
                p256dh=request.p256dh,
                auth=request.auth,
            )
        )
    await session.commit()
    return {"status": "subscribed"}


@router.delete("/subscribe")
async def unsubscribe(
    endpoint: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    await session.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == user.id,
        )
    )
    await session.commit()
    return {"status": "unsubscribed"}


@router.post("/test")
async def send_test(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Dev helper: send a test push (if push enabled + subscribed) and a test
    email (if email_reminders on)."""
    prefs = await get_or_create_prefs(session, user.id)
    attempted = False
    if prefs.push_enabled:
        await _push_to_user(session, user, "Prysm Note", "Test push notification")
        attempted = True
    if prefs.email_reminders and user.email:
        send_email(user.email, "Prysm Note test", "This is a test notification from Prysm Note.")
        attempted = True
    await session.commit()
    if not attempted:
        raise HTTPException(status_code=400, detail="Enable email reminders or push to test")
    return {"status": "sent"}
