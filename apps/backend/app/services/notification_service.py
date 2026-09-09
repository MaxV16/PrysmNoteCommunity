"""Notification engine: per-user preferences, due-date alerts (email + Web Push),
and the daily digest email. Runs as an in-process background loop (see main.py)
through the BYPASSRLS system session so it can read all users' data.
"""

import asyncio
import logging
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models.notifications import NotificationLog, PushSubscription, UserNotificationPrefs
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.email import send_email
from app.services.push_service import send_push

logger = logging.getLogger(__name__)


async def get_or_create_prefs(session: AsyncSession, user_id) -> UserNotificationPrefs:
    result = await session.execute(
        select(UserNotificationPrefs).where(UserNotificationPrefs.user_id == user_id)
    )
    prefs = result.scalar_one_or_none()
    if prefs is None:
        prefs = UserNotificationPrefs(user_id=user_id)
        session.add(prefs)
        await session.flush()
    return prefs


async def _log_sent(session: AsyncSession, user_id, task_id, kind: str) -> None:
    session.add(NotificationLog(user_id=user_id, task_id=task_id, kind=kind))
    await session.flush()


async def _push_to_user(session: AsyncSession, user: User, title: str, body: str) -> None:
    result = await session.execute(
        select(PushSubscription).where(PushSubscription.user_id == user.id)
    )
    subs = result.scalars().all()
    stale = []
    for sub in subs:
        result = send_push(sub.endpoint, sub.p256dh, sub.auth, {"title": title, "body": body})
        if result == "stale":
            stale.append(sub)
    for sub in stale:
        await session.delete(sub)
    if stale:
        await session.flush()


def _due_tasks_for_window(session: AsyncSession, start: date, end: date):
    return select(Task).where(
        Task.due_date >= start,
        Task.due_date <= end,
        Task.deleted_at.is_(None),
        Task.status.notin_([TaskStatus.DONE.value, TaskStatus.CANCELLED.value]),
        Task.is_archived.is_(False),
    )


async def send_due_alerts(session: AsyncSession) -> int:
    """Email + push a "due soon" alert for tasks due today or tomorrow, at most
    once per task per user (deduped via NotificationLog)."""
    today = date.today()
    tomorrow = today + timedelta(days=1)
    result = await session.execute(_due_tasks_for_window(session, today, tomorrow))
    tasks = result.scalars().all()
    if not tasks:
        return 0

    sent = 0
    for task in tasks:
        prefs = await get_or_create_prefs(session, task.user_id)
        if not prefs.due_alerts:
            continue
        already = await session.execute(
            select(NotificationLog).where(
                NotificationLog.user_id == task.user_id,
                NotificationLog.task_id == task.id,
                NotificationLog.kind == "due",
            )
        )
        if already.scalar_one_or_none():
            continue

        user_result = await session.execute(select(User).where(User.id == task.user_id))
        user = user_result.scalar_one_or_none()
        if user is None:
            continue

        title = f"Reminder: Due soon - {task.title}"
        body = f"'{task.title}' is due {task.due_date.isoformat()} - don't let it slip."
        attempted = False
        if prefs.email_reminders and user.email:
            send_email(
                user.email, title, body, from_email=settings.notify_email or settings.admin_email
            )
            attempted = True
        if prefs.push_enabled:
            await _push_to_user(session, user, title, body)
            attempted = True
        if attempted:
            await _log_sent(session, task.user_id, task.id, "due")
            sent += 1
    await session.flush()
    return sent


def _due_today_tasks(session: AsyncSession, day: date):
    return select(Task).where(
        Task.due_date == day,
        Task.deleted_at.is_(None),
        Task.status.notin_([TaskStatus.DONE.value, TaskStatus.CANCELLED.value]),
        Task.is_archived.is_(False),
    )


async def send_daily_digests(session: AsyncSession, day: date | None = None) -> int:
    """Send the daily digest email (summary of today's tasks) once per calendar
    day per user."""
    day = day or date.today()
    already_result = await session.execute(
        select(NotificationLog).where(NotificationLog.kind == "digest")
    )
    already_sent_user_ids = {log.user_id for log in already_result.scalars().all()}

    prefs_result = await session.execute(
        select(UserNotificationPrefs).where(UserNotificationPrefs.email_digest.is_(True))
    )
    targets = prefs_result.scalars().all()
    if not targets:
        return 0

    sent = 0
    for prefs in targets:
        if prefs.user_id in already_sent_user_ids:
            continue
        tasks_result = await session.execute(_due_today_tasks(session, day))
        tasks = tasks_result.scalars().all()
        if not tasks:
            continue
        user_result = await session.execute(select(User).where(User.id == prefs.user_id))
        user = user_result.scalar_one_or_none()
        if user is None or not user.email:
            continue

        lines = "\n".join(f"- {t.title}" for t in tasks)
        subject = f"Your plan for {day.isoformat()}"
        body = f"Here's what's on your plate today:\n\n{lines}\n\nHave a productive day!"
        send_email(user.email, subject, body)
        await _log_sent(session, prefs.user_id, None, "digest")
        sent += 1
    await session.flush()
    return sent


async def notification_background_loop(session_factory: async_sessionmaker) -> None:
    """Background loop: due alerts every interval, daily digest at digest_hour.
    No-op when NOTIFICATIONS_ENABLED is off (safe on dev/community builds)."""
    while True:
        try:
            async with session_factory() as session:
                if settings.notifications_enabled:
                    await send_due_alerts(session)
                    if datetime.now().hour == settings.digest_hour:
                        await send_daily_digests(session)
                    await session.commit()
        except Exception:
            logger.exception("notification loop pass failed")
        await asyncio.sleep(settings.notification_loop_interval)
