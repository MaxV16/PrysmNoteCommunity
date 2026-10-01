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
from app.services.email import send_email_async
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
        # Reminders are per-task opt-in: nothing is alerted unless the user
        # explicitly asked to be reminded about that task.
        Task.reminder_enabled.is_(True),
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

    # Batch-load all user IDs, prefs, and notification logs upfront.
    task_user_ids = list({t.user_id for t in tasks})
    prefs_result = await session.execute(
        select(UserNotificationPrefs).where(UserNotificationPrefs.user_id.in_(task_user_ids))
    )
    prefs_by_user = {p.user_id: p for p in prefs_result.scalars().all()}

    user_result = await session.execute(select(User).where(User.id.in_(task_user_ids)))
    users_by_id = {u.id: u for u in user_result.scalars().all()}

    task_ids = [t.id for t in tasks]
    logs_result = await session.execute(
        select(NotificationLog).where(
            NotificationLog.user_id.in_(task_user_ids),
            NotificationLog.task_id.in_(task_ids),
            NotificationLog.kind == "due",
        )
    )
    already_sent: set[tuple[str, str]] = {
        (str(log.user_id), str(log.task_id)) for log in logs_result.scalars().all()
    }

    sent = 0
    for task in tasks:
        uid = task.user_id
        if (str(uid), str(task.id)) in already_sent:
            continue

        prefs = prefs_by_user.get(uid)
        if prefs is None:
            # Create prefs on demand with defaults (due_alerts=True).
            prefs = UserNotificationPrefs(user_id=uid)
            session.add(prefs)
            await session.flush()
            prefs_by_user[uid] = prefs
        if not prefs.due_alerts:
            continue

        user = users_by_id.get(uid)
        if user is None:
            continue

        title = f"Reminder: Due soon - {task.title}"
        body = f"'{task.title}' is due {task.due_date.isoformat()} - don't let it slip."
        attempted = False
        if prefs.email_reminders and user.email:
            await send_email_async(
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
    # Dedupe must be per DAY, not once-ever: filter the log to this day so the
    # digest is sent daily instead of only the first time.
    day_start = datetime(day.year, day.month, day.day)
    already_result = await session.execute(
        select(NotificationLog).where(
            NotificationLog.kind == "digest",
            NotificationLog.sent_at >= day_start,
        )
    )
    already_sent_user_ids = {log.user_id for log in already_result.scalars().all()}

    prefs_result = await session.execute(
        select(UserNotificationPrefs).where(UserNotificationPrefs.email_digest.is_(True))
    )
    targets = prefs_result.scalars().all()
    if not targets:
        return 0

    # Batch-load all users for the digest targets.
    target_user_ids = [p.user_id for p in targets if p.user_id not in already_sent_user_ids]
    if not target_user_ids:
        return 0
    user_result = await session.execute(select(User).where(User.id.in_(target_user_ids)))
    users_by_id = {u.id: u for u in user_result.scalars().all()}

    # Load all tasks due today for all target users in one query.
    tasks_result = await session.execute(_due_today_tasks(session, day))
    all_tasks = tasks_result.scalars().all()
    tasks_by_user: dict[str, list[Task]] = {}
    for t in all_tasks:
        uid = str(t.user_id)
        tasks_by_user.setdefault(uid, []).append(t)

    sent = 0
    for prefs in targets:
        if prefs.user_id in already_sent_user_ids:
            continue
        tasks = tasks_by_user.get(str(prefs.user_id), [])
        if not tasks:
            continue
        user = users_by_id.get(prefs.user_id)
        if user is None or not user.email:
            continue

        lines = "\n".join(f"- {t.title}" for t in tasks)
        subject = f"Your plan for {day.isoformat()}"
        body = f"Here's what's on your plate today:\n\n{lines}\n\nHave a productive day!"
        await send_email_async(user.email, subject, body)
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
