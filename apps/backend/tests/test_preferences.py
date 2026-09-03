import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.user_preference import UserPreference


@pytest.mark.asyncio
async def test_put_and_get_preference(client: AsyncClient):
    resp = await client.put("/api/preferences/board_kanban_scroll_direction", json={"value": "vertical"})
    assert resp.status_code == 200
    assert resp.json() == {"key": "board_kanban_scroll_direction", "value": "vertical"}

    resp = await client.get("/api/preferences/")
    assert resp.status_code == 200
    assert resp.json()["board_kanban_scroll_direction"] == "vertical"


@pytest.mark.asyncio
async def test_put_upserts(client: AsyncClient):
    await client.put("/api/preferences/default_view", json={"value": "timeline"})
    resp = await client.put("/api/preferences/default_view", json={"value": "board"})
    assert resp.status_code == 200
    assert resp.json()["value"] == "board"
    prefs = (await client.get("/api/preferences/")).json()
    assert prefs["default_view"] == "board"
    assert len(prefs) == 1  # upserted, not duplicated


@pytest.mark.asyncio
async def test_put_stores_any_json_value(client: AsyncClient):
    await client.put("/api/preferences/nested", json={"value": {"a": [1, 2, {"b": True}], "c": "x"}})
    prefs = (await client.get("/api/preferences/")).json()
    assert prefs["nested"] == {"a": [1, 2, {"b": True}], "c": "x"}


@pytest.mark.asyncio
async def test_delete_preference(client: AsyncClient):
    await client.put("/api/preferences/foo", json={"value": 1})
    assert (await client.delete("/api/preferences/foo")).status_code == 200
    prefs = (await client.get("/api/preferences/")).json()
    assert "foo" not in prefs
    assert (await client.delete("/api/preferences/foo")).status_code == 404


@pytest.mark.asyncio
async def test_delete_unknown_preference_404(client: AsyncClient):
    assert (await client.delete("/api/preferences/ghost")).status_code == 404


@pytest.mark.asyncio
async def test_overlong_key_rejected(client: AsyncClient):
    resp = await client.put(f"/api/preferences/{'k' * 65}", json={"value": 1})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_cross_user_isolation(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="pref-other@test", password_hash="x")
    db_session.add(other)
    db_session.add(UserPreference(user_id=other.id, key="secret_key", value={"hidden": True}))
    await db_session.commit()

    prefs = (await client.get("/api/preferences/")).json()
    assert "secret_key" not in prefs

    # Deleting another user's pref must 404 (never touch it).
    assert (await client.delete("/api/preferences/secret_key")).status_code == 404
