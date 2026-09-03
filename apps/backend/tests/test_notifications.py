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
    # create-on-read returns defaults
    res = await client.get("/api/notifications/prefs")
    assert res.status_code == 200
    data = res.json()
    assert data["email_reminders"] is True
    assert data["email_digest"] is False

    res = await client.patch("/api/notifications/prefs", json={"email_digest": True, "sound": False})
    assert res.status_code == 200
    data = res.json()
    assert data["email_digest"] is True
    assert data["sound"] is False
    assert data["email_reminders"] is True


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
    )
    db_session.add(task)
    await db_session.commit()

    emails = []
    monkeypatch.setattr(
        notification_service,
        "send_email",
        lambda *a, **k: emails.append({"args": a, "kwargs": k}),
    )

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
    )
    db_session.add(task)
    await db_session.commit()

    emails = []
    monkeypatch.setattr(
        notification_service,
        "send_email",
        lambda *a, **k: emails.append({"args": a, "kwargs": k}),
    )

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
    )
    db_session.add(task)
    prefs = UserNotificationPrefs(user_id=test_user.id, due_alerts=False)
    db_session.add(prefs)
    await db_session.commit()

    emails = []
    monkeypatch.setattr(notification_service, "send_email", lambda *a, **k: emails.append(a))

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
    monkeypatch.setattr(notification_service, "send_email", lambda *a, **k: emails.append(a))

    await notification_service.send_daily_digests(db_session, day=date.today())
    await notification_service.send_daily_digests(db_session, day=date.today())
    await db_session.commit()

    assert len(emails) == 1, "digest must be sent at most once per calendar day"
    digest_logs = (
        await db_session.execute(select(NotificationLog).where(NotificationLog.kind == "digest"))
    ).scalars().all()
    assert len(digest_logs) == 1
