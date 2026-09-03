import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics_event import AnalyticsDaily, AnalyticsEvent
from app.models.user import User
from app.services import analytics


@pytest.fixture
def empty_queue():
    """Ensure a fresh, empty analytics queue for each test."""
    q = analytics._queue()
    while not q.empty():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break
    yield q
    while not q.empty():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break


@pytest.mark.asyncio
async def test_track_returns_204(client: AsyncClient, empty_queue):
    resp = await client.post(
        "/api/analytics/track",
        json={"event": "task_created", "properties": {"source": "button"}, "session_id": "s1"},
    )
    assert resp.status_code == 204
    # The event is enqueued, not written synchronously.
    assert analytics._queue().qsize() == 1


@pytest.mark.asyncio
async def test_track_requires_auth(auth_client: AsyncClient, empty_queue):
    resp = await auth_client.post(
        "/api/analytics/track", json={"event": "signed_up"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_track_rejects_invalid_payloads(client: AsyncClient, empty_queue):
    assert (await client.post("/api/analytics/track", json={"event": ""})).status_code == 422
    assert (await client.post("/api/analytics/track", json={"event": " "})).status_code == 422
    assert (await client.post("/api/analytics/track", json={"event": "x" * 65})).status_code == 422
    big = {"pad": "x" * 5000}
    assert (await client.post("/api/analytics/track", json={"event": "e", "properties": big})).status_code == 422


@pytest.mark.asyncio
async def test_track_applies_csrf(auth_client: AsyncClient, empty_queue):
    """The analytics endpoint is NOT csrf-exempt - a POST without the header is
    rejected when CSRF is enabled, exactly like every other /api POST."""
    from app.config import settings

    settings.csrf_enabled = True
    try:
        await auth_client.post("/api/auth/register", json={
            "email": "an@example.com",
            "password": "password123",
        })
        resp = await auth_client.post(
            "/api/analytics/track", json={"event": "task_created"}
        )
        assert resp.status_code == 403
        assert "CSRF" in resp.json()["detail"]
    finally:
        settings.csrf_enabled = False


@pytest.mark.asyncio
async def test_track_rate_limited(client: AsyncClient, test_user, empty_queue):
    from app.routers import analytics as analytics_module

    limiter = analytics_module._track_limiter
    limiter._memory.clear()
    # Fake an exhausted limit so the request 429s deterministically.
    for _ in range(analytics_module._TRACK_LIMIT):
        limiter.count(str(test_user.id), analytics_module._TRACK_WINDOW)
    resp = await client.post("/api/analytics/track", json={"event": "spam"})
    assert resp.status_code == 429
    limiter._memory.clear()


@pytest.mark.asyncio
async def test_flush_writes_events(test_user, empty_queue):
    from tests.conftest import _test_session_factory as _test_factory

    analytics.enqueue_event(str(test_user.id), "task_created", {"src": "btn"}, "sess")
    analytics.enqueue_event(None, "anonymous_event")
    flushed = await analytics.flush_pending(_test_factory)
    assert flushed == 2

    async with _test_factory() as session:
        rows = (await session.execute(select(AnalyticsEvent))).scalars().all()
        assert len(rows) == 2
        by_event = {r.event: r for r in rows}
        assert str(by_event["task_created"].user_id) == str(test_user.id)
        assert by_event["task_created"].properties == {"src": "btn"}
        assert by_event["task_created"].session_id == "sess"
        assert by_event["anonymous_event"].user_id is None


@pytest.mark.asyncio
async def test_enqueue_rejects_bad_events(empty_queue):
    assert analytics.enqueue_event(None, "") is False
    assert analytics.enqueue_event(None, "x" * 65) is False
    assert analytics.enqueue_event(None, "ok", {"nested": {"deep": "value"}}) is True
    assert analytics.enqueue_event(None, "ok", {"pad": "x" * 5000}) is False
    assert analytics.enqueue_event(None, "ok", ["not", "a", "dict"]) is False


@pytest.mark.asyncio
async def test_rollup_aggregates_and_prunes(db_session: AsyncSession, empty_queue):
    from app.config import settings
    from tests.conftest import _test_session_factory as _test_factory

    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    day_start = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)

    # Postgres enforces the FK: the raw rows must reference real users, so
    # create them first (SQLite does not enforce FKs, but this keeps the test
    # portable and Postgres-clean).
    u1 = uuid4()
    u2 = uuid4()
    db_session.add_all([
        User(id=u1, email="rollup-1@test", password_hash="x"),
        User(id=u2, email="rollup-2@test", password_hash="x"),
    ])
    await db_session.flush()
    db_session.add_all([
        AnalyticsEvent(user_id=u1, event="mic_pressed", properties={}, created_at=day_start + timedelta(hours=1)),
        AnalyticsEvent(user_id=u1, event="mic_pressed", properties={}, created_at=day_start + timedelta(hours=2)),
        AnalyticsEvent(user_id=u2, event="mic_pressed", properties={}, created_at=day_start + timedelta(hours=3)),
        AnalyticsEvent(user_id=u1, event="trial_started", properties={}, created_at=day_start + timedelta(hours=4)),
    ])
    await db_session.commit()

    await analytics.run_rollup(_test_factory)

    async with _test_factory() as session:
        daily = (await session.execute(select(AnalyticsDaily))).scalars().all()
        by_event = {d.event: d for d in daily}
        assert by_event["mic_pressed"].count == 3
        assert by_event["mic_pressed"].unique_users == 2
        assert by_event["trial_started"].count == 1

    # Pruning: an old event (beyond retention) is removed.
    old = now - timedelta(days=settings.analytics_retention_days + 5)
    db_session.add(AnalyticsEvent(user_id=u1, event="stale_event", properties={}, created_at=old))
    await db_session.commit()

    await analytics.run_rollup(_test_factory)

    async with _test_factory() as session:
        stale = (await session.execute(
            select(AnalyticsEvent).where(AnalyticsEvent.event == "stale_event")
        )).scalars().all()
        assert stale == []


@pytest.mark.asyncio
async def test_rls_isolation(client: AsyncClient, test_user, db_session: AsyncSession, empty_queue):
    """A user's raw analytics events are invisible to another user (RLS)."""
    other = User(id=uuid4(), email="analytics-other@test", password_hash="x")
    db_session.add(other)
    await db_session.flush()
    other_event = AnalyticsEvent(user_id=other.id, event="task_created", properties={"secret": True})
    db_session.add(other_event)
    await db_session.commit()

    # Query through a fresh session bound to the test_user's RLS identity.
    from tests.conftest import _test_session_factory as _test_factory
    from app.utils.rls import set_rls_user_id

    async with _test_factory() as session:
        if session.bind.dialect.name == "postgresql":
            await set_rls_user_id(session, test_user.id)
        visible = (await session.execute(select(AnalyticsEvent))).scalars().all()
        # On SQLite there is no RLS, so this assertion only runs on Postgres.
        if session.bind.dialect.name == "postgresql":
            # CI/dev run the suite as the postgres superuser, which bypasses RLS
            # even with FORCE ROW LEVEL SECURITY - the isolation guarantee can
            # only be verified under a non-superuser app role (as in prod, and
            # in test_rls_enforcement.py's dedicated non-superuser provisioning).
            is_super = (await session.execute(
                text("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
            )).scalar()
            if is_super:
                pytest.skip("RLS isolation is unverifiable as the superuser role")
            assert all(str(e.user_id) != str(other.id) for e in visible)
