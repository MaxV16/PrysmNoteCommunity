import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.user_token import UserToken
from app.services.calendar_service import store_tokens

_FERNET_KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _valid_encryption_key(monkeypatch):
    # The local/CI ENCRYPTION_KEY may not be a real Fernet key; token
    # encryption needs one (same pattern as test_calendar_tokens.py).
    monkeypatch.setattr(settings, "encryption_key", _FERNET_KEY)


@pytest.fixture(autouse=True)
def _no_google_network(monkeypatch):
    """The manual pull hits the Google API via _list_events_blocking; replace it
    with a deterministic stub so tests never touch the network."""
    def _stub_list(access_token, refresh_token, max_results=50):
        return [], None

    import app.services.calendar_service as cs

    monkeypatch.setattr(cs, "_list_events_blocking", _stub_list)


@pytest.mark.asyncio
async def test_calendar_status_not_connected(client: AsyncClient):
    response = await client.get("/api/calendar/status")
    assert response.status_code == 200
    assert response.json() == {"connected": False, "last_synced_at": None}


@pytest.mark.asyncio
async def test_calendar_status_connected(client: AsyncClient, test_user: User, db_session: AsyncSession):
    await store_tokens(db_session, test_user.id, "fake-access", "fake-refresh", None)
    await db_session.commit()

    response = await client.get("/api/calendar/status")
    assert response.status_code == 200
    body = response.json()
    assert body["connected"] is True
    assert body["last_synced_at"] is None


@pytest.mark.asyncio
async def test_calendar_pull_sets_last_pulled_at_and_429(client: AsyncClient, test_user: User, db_session: AsyncSession):
    await store_tokens(db_session, test_user.id, "fake-access", "fake-refresh", None)
    await db_session.commit()

    first = await client.post("/api/calendar/pull")
    assert first.status_code == 200
    assert first.json()["imported"] == 0

    result = await db_session.execute(
        UserToken.__table__.select().where(UserToken.user_id == test_user.id)
    )
    row = result.fetchone()
    assert row is not None
    assert row.last_pulled_at is not None

    status = (await client.get("/api/calendar/status")).json()
    assert status["connected"] is True
    assert status["last_synced_at"] is not None

    # Second pull within the manual-sync interval → 429 with a friendly detail.
    second = await client.post("/api/calendar/pull")
    assert second.status_code == 429
    assert "recently" in second.json()["detail"]


@pytest.mark.asyncio
async def test_calendar_pull_429_clears_after_interval(client: AsyncClient, test_user: User, db_session: AsyncSession, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "calendar_manual_sync_min_interval", 0)
    await store_tokens(db_session, test_user.id, "fake-access", "fake-refresh", None)
    await db_session.commit()

    assert (await client.post("/api/calendar/pull")).status_code == 200
    # With the interval zeroed the guard never trips.
    assert (await client.post("/api/calendar/pull")).status_code == 200
