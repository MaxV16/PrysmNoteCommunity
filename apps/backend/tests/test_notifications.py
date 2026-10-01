from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.config import settings
from app.models.notifications import NotificationLog, PushSubscription, UserNotificationPrefs
from app.models.task import Task
from app.services import notification_service


@pytest.mark.asyncio
async def test_prefs_get_patches(client, test_user):
    # create-on-read returns defaults: in-app reminders on, email off.
    res = await client.get("/api/notifications/prefs")
    assert res.status_code == 200
    data = res.json()
    assert data["inapp_reminders"] is True
    assert data["reminder_time"] == "20:00"
    assert data["email_reminders"] is False
    assert data["email_digest"] is False

    res = await client.patch(
        "/api/notifications/prefs",
        json={
            "email_digest": True,
            "sound": False,
            "inapp_reminders": False,
            "reminder_time": "09:30",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["email_digest"] is True
    assert data["sound"] is False
    assert data["inapp_reminders"] is False
    assert data["reminder_time"] == "09:30"
    assert data["email_reminders"] is False


@pytest.mark.asyncio
async def test_prefs_rejects_bad_reminder_time(client, test_user):
    res = await client.patch("/api/notifications/prefs", json={"reminder_time": "25:99"})
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_reminder_tasks_covers_old_overdue_and_filters(client, test_user, db_session):
    """F7: the reminder source must reach old overdue tasks outside the client's
    loaded window, while excluding done/cancelled/archived/deleted/no-date ones."""
    today = date.today()
    old_overdue = today - timedelta(days=400)
    db_session.add_all(
        [
            Task(id=uuid4(), user_id=test_user.id, title="Very old overdue", status="todo", due_date=old_overdue, reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Due tomorrow", status="todo", due_date=today + timedelta(days=1), reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Start date overdue", status="todo", start_date=old_overdue, due_date=None, reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Far future", status="todo", due_date=today + timedelta(days=30), reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Done overdue", status="done", due_date=old_overdue, reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Cancelled overdue", status="cancelled", due_date=old_overdue, reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="Archived overdue", status="todo", due_date=old_overdue, is_archived=True, reminder_enabled=True),
            Task(id=uuid4(), user_id=test_user.id, title="No date", status="todo", reminder_enabled=True),
            # Reminders are per-task opt-in: this one must be excluded.
            Task(id=uuid4(), user_id=test_user.id, title="Not opted in", status="todo", due_date=old_overdue),
        ]
    )
    await db_session.commit()

    res = await client.get("/api/notifications/reminder-tasks")
    assert res.status_code == 200
    titles = [row["title"] for row in res.json()]
    assert titles == ["Start date overdue", "Very old overdue", "Due tomorrow"]
    assert all(t in titles for t in ("Very old overdue", "Due tomorrow", "Start date overdue"))


@pytest.mark.asyncio
async def test_reminder_tasks_limit_and_bad_before(client, test_user, db_session):
    today = date.today()
    for i in range(3):
        db_session.add(
            Task(id=uuid4(), user_id=test_user.id, title=f"Overdue {i}", status="todo", due_date=today - timedelta(days=i + 1), reminder_enabled=True)
        )
    await db_session.commit()

    res = await client.get("/api/notifications/reminder-tasks?limit=1")
    assert res.status_code == 200
    assert len(res.json()) == 1

    assert (await client.get("/api/notifications/reminder-tasks?before=not-a-date")).status_code == 422


@pytest.mark.asyncio
async def test_vapid_public_key_endpoint(client):
    res = await client.get("/api/notifications/vapid-public-key")
    assert res.status_code == 200
    assert "public_key" in res.json()


@pytest.mark.asyncio
async def test_subscribe_unsubscribe(client, test_user, db_session):
    endpoint = "https://fcm.googleapis.com/fcm/send/test-ep"
    res = await client.post(
        "/api/notifications/subscribe",
        json={"endpoint": endpoint, "p256dh": "aGVsbG8=", "auth": "d29ybGQ="},
    )
    assert res.status_code == 200

    found = (await db_session.execute(select(PushSubscription))).scalar_one()
    assert found.endpoint == endpoint
    assert found.user_id == test_user.id

    res = await client.delete(f"/api/notifications/subscribe?endpoint={endpoint}")
    assert res.status_code == 200
    assert (await db_session.execute(select(PushSubscription))).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_subscribe_rejects_non_push_service_endpoint(client):
    """M2: arbitrary URLs (internal/metadata endpoints) must be rejected so the
    notification loop can't be used as a blind SSRF."""
    res = await client.post(
        "/api/notifications/subscribe",
        json={"endpoint": "http://169.254.169.254/latest/meta-data/", "p256dh": "aGVsbG8=", "auth": "d29ybGQ="},
    )
    assert res.status_code == 400
    res = await client.post(
        "/api/notifications/subscribe",
        json={"endpoint": "https://127.0.0.1:8000/notify", "p256dh": "aGVsbG8=", "auth": "d29ybGQ="},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_due_alert_dedupes(client, test_user, db_session, monkeypatch):
    task = Task(
        id=uuid4(),
        user_id=test_user.id,
        title="Due today task",
        status="todo",
        due_date=date.today(),
        reminder_enabled=True,
    )
    db_session.add(task)
    db_session.add(UserNotificationPrefs(user_id=test_user.id, email_reminders=True))
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append({"args": a, "kwargs": k})

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_due_alerts(db_session)
    await notification_service.send_due_alerts(db_session)
    await db_session.commit()

    assert len(emails) == 1, "due alert must be sent at most once per task"
    logs = (await db_session.execute(select(NotificationLog))).scalars().all()
    assert len(logs) == 1
    assert logs[0].kind == "due"
    assert logs[0].task_id == task.id


@pytest.mark.asyncio
async def test_due_alert_title_and_from(client, test_user, db_session, monkeypatch):
    task = Task(
        id=uuid4(),
        user_id=test_user.id,
        title="Q3 planning",
        status="todo",
        due_date=date.today(),
        reminder_enabled=True,
    )
    db_session.add(task)
    db_session.add(UserNotificationPrefs(user_id=test_user.id, email_reminders=True))
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append({"args": a, "kwargs": k})

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_due_alerts(db_session)
    await db_session.commit()

    assert len(emails) == 1
    args, kwargs = emails[0]["args"], emails[0]["kwargs"]
    assert args[0] == test_user.email
    assert args[1].startswith("Reminder: Due soon - ")
    assert "Q3 planning" in args[1]
    expected_from = settings.notify_email or settings.admin_email
    assert kwargs.get("from_email") == expected_from


@pytest.mark.asyncio
async def test_due_alert_respects_prefs(client, test_user, db_session, monkeypatch):
    task = Task(
        id=uuid4(),
        user_id=test_user.id,
        title="Silent task",
        status="todo",
        due_date=date.today(),
        reminder_enabled=True,
    )
    db_session.add(task)
    prefs = UserNotificationPrefs(user_id=test_user.id, due_alerts=False)
    db_session.add(prefs)
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append(a)

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_due_alerts(db_session)
    await db_session.commit()

    assert emails == []
    assert (await db_session.execute(select(NotificationLog))).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_digest_sent_once_per_day(client, test_user, db_session, monkeypatch):
    task = Task(
        id=uuid4(),
        user_id=test_user.id,
        title="Digest task",
        status="todo",
        due_date=date.today(),
    )
    db_session.add(task)
    prefs = UserNotificationPrefs(user_id=test_user.id, email_digest=True)
    db_session.add(prefs)
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append(a)

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_daily_digests(db_session, day=date.today())
    await notification_service.send_daily_digests(db_session, day=date.today())
    await db_session.commit()

    assert len(emails) == 1, "digest must be sent at most once per calendar day"
    digest_logs = (
        await db_session.execute(select(NotificationLog).where(NotificationLog.kind == "digest"))
    ).scalars().all()
    assert len(digest_logs) == 1


@pytest.mark.asyncio
async def test_due_alert_requires_task_opt_in(client, test_user, db_session, monkeypatch):
    """Reminders are per-task: a task without reminder_enabled sends nothing even
    when the user has email reminders and due alerts enabled."""
    db_session.add(
        Task(id=uuid4(), user_id=test_user.id, title="Not opted in", status="todo", due_date=date.today())
    )
    db_session.add(
        UserNotificationPrefs(user_id=test_user.id, email_reminders=True, due_alerts=True)
    )
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append(a)

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_due_alerts(db_session)
    await db_session.commit()

    assert emails == []


@pytest.mark.asyncio
async def test_digest_sends_again_next_day(client, test_user, db_session, monkeypatch):
    """The digest dedupe must be per DAY, not once-ever."""
    db_session.add(
        Task(id=uuid4(), user_id=test_user.id, title="Digest today", status="todo", due_date=date.today())
    )
    db_session.add(
        Task(id=uuid4(), user_id=test_user.id, title="Digest tomorrow", status="todo", due_date=date.today() + timedelta(days=1))
    )
    db_session.add(UserNotificationPrefs(user_id=test_user.id, email_digest=True))
    await db_session.commit()

    emails = []
    async def _capture(*a, **k):
        emails.append(a)

    monkeypatch.setattr(notification_service, "send_email_async", _capture)

    await notification_service.send_daily_digests(db_session, day=date.today())
    await db_session.commit()
    assert len(emails) == 1

    # A new day re-sends (the old code deduped once-ever).
    await notification_service.send_daily_digests(db_session, day=date.today() + timedelta(days=1))
    await db_session.commit()
    assert len(emails) == 2
