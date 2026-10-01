from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.notifications import PushSubscription, UserNotificationPrefs
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.notification_service import get_or_create_prefs, _push_to_user
from app.services.email import send_email_async

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class UpdatePrefsRequest(BaseModel):
    inapp_reminders: Optional[bool] = None
    reminder_time: Optional[str] = None
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
        "inapp_reminders": prefs.inapp_reminders,
        "reminder_time": prefs.reminder_time,
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
    if request.reminder_time is not None:
        import re

        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", request.reminder_time):
            raise HTTPException(status_code=422, detail="reminder_time must be HH:MM (24h)")
    prefs = await get_or_create_prefs(session, user.id)
    for field in (
        "inapp_reminders",
        "reminder_time",
        "email_reminders",
        "due_alerts",
        "email_digest",
        "push_enabled",
        "sound",
    ):
        value = getattr(request, field)
        if value is not None:
            setattr(prefs, field, value)
    await session.commit()
    return _prefs_dict(prefs)


# Cap on the reminder source query. The in-app stack only surfaces a handful of
# cards, so a bounded list is enough to cover old overdue tasks without an
# unbounded scan.
REMINDER_TASKS_MAX = 200


@router.get("/reminder-tasks")
async def reminder_tasks(
    before: Optional[str] = None,
    limit: int = 100,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Open tasks dated on/before ``before`` (default: tomorrow), oldest first.

    The in-app reminder engine runs in the browser from the loaded task window,
    so a very old overdue task outside that window was never reminded (F7). This
    bounded server query is the reminder source; the client falls back to its
    cached window if the request fails.
    """
    if before is None:
        before_date = date.today() + timedelta(days=1)
    else:
        try:
            before_date = date.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=422, detail="before must be YYYY-MM-DD")

    limit = max(1, min(limit, REMINDER_TASKS_MAX))
    effective_date = func.coalesce(Task.due_date, Task.start_date)
    result = await session.execute(
        select(Task)
        .where(
            Task.user_id == user.id,
            Task.deleted_at.is_(None),
            Task.is_archived.is_(False),
            Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
            effective_date.is_not(None),
            effective_date <= before_date,
            # Reminders are per-task opt-in: only tasks the user marked.
            Task.reminder_enabled.is_(True),
        )
        .order_by(effective_date.asc(), Task.title.asc())
        .limit(limit)
    )
    return [
        {
            "id": str(task.id),
            "title": task.title,
            "due_date": task.due_date.isoformat() if task.due_date else None,
            "start_date": task.start_date.isoformat() if task.start_date else None,
        }
        for task in result.scalars().all()
    ]


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
        await send_email_async(user.email, "Prysm Note test", "This is a test notification from Prysm Note.")
        attempted = True
    await session.commit()
    if not attempted:
        raise HTTPException(status_code=400, detail="Enable email reminders or push to test")
    return {"status": "sent"}
