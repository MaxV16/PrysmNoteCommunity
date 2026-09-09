import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.timeline_section import TimelineSection
from app.models.user import User


@pytest.mark.asyncio
async def test_list_starts_empty(client: AsyncClient):
    resp = await client.get("/api/timeline-sections/")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_create_section(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={
        "name": "Focus", "color": "#4FC3F7", "start_pct": 50, "end_pct": 100,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Focus"
    assert data["color"] == "#4FC3F7"
    assert data["start_pct"] == 50
    assert data["end_pct"] == 100
    assert data["rule_kind"] is None
    assert data["position"] == 0


@pytest.mark.asyncio
async def test_create_with_rule(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={
        "name": "High priority", "start_pct": 0, "end_pct": 40,
        "rule_kind": "priority", "rule_value": "4,5",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["rule_kind"] == "priority"
    assert data["rule_value"] == "4,5"


@pytest.mark.asyncio
async def test_invalid_rule_kind_rejected(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={
        "name": "Bad", "rule_kind": "bogus",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_inverted_percentages_rejected(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={
        "name": "Bad", "start_pct": 90, "end_pct": 10,
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_out_of_range_percentage_rejected(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={
        "name": "Bad", "start_pct": 101,
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_empty_name_rejected(client: AsyncClient):
    resp = await client.post("/api/timeline-sections/", json={"name": "   "})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_section(client: AsyncClient):
    created = (await client.post("/api/timeline-sections/", json={"name": "A", "start_pct": 20, "end_pct": 60})).json()
    resp = await client.patch(
        f"/api/timeline-sections/{created['id']}",
        json={"name": "B", "color": "#123456", "start_pct": 10, "end_pct": 55, "rule_kind": "status", "rule_value": "done"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "B"
    assert data["color"] == "#123456"
    assert data["start_pct"] == 10
    assert data["end_pct"] == 55
    assert data["rule_kind"] == "status"
    assert data["rule_value"] == "done"


@pytest.mark.asyncio
async def test_patch_inverted_percentages_rejected(client: AsyncClient):
    created = (await client.post("/api/timeline-sections/", json={"name": "A", "start_pct": 20, "end_pct": 60})).json()
    resp = await client.patch(
        f"/api/timeline-sections/{created['id']}",
        json={"start_pct": 70},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_unknown_section_404(client: AsyncClient):
    resp = await client.patch("/api/timeline-sections/00000000-0000-0000-0000-000000000000", json={"name": "Ghost"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section(client: AsyncClient):
    created = (await client.post("/api/timeline-sections/", json={"name": "Drop"})).json()
    resp = await client.delete(f"/api/timeline-sections/{created['id']}")
    assert resp.status_code == 200
    assert (await client.get("/api/timeline-sections/")).json() == []


@pytest.mark.asyncio
async def test_position_ordering(client: AsyncClient):
    for i, name in enumerate(["First", "Second", "Third"]):
        resp = await client.post("/api/timeline-sections/", json={"name": name})
        assert resp.status_code == 200
        assert resp.json()["position"] == i
    resp = await client.get("/api/timeline-sections/")
    assert [s["name"] for s in resp.json()] == ["First", "Second", "Third"]


@pytest.mark.asyncio
async def test_cross_user_isolation(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="sections-other@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_section = TimelineSection(user_id=other.id, name="Secret", color="#000000", start_pct=0, end_pct=50, position=0)
    db_session.add(other_section)
    await db_session.commit()

    resp = await client.get("/api/timeline-sections/")
    assert all(s["id"] != str(other_section.id) for s in resp.json())

    assert (await client.patch(f"/api/timeline-sections/{other_section.id}", json={"name": "hacked"})).status_code == 404
    assert (await client.delete(f"/api/timeline-sections/{other_section.id}")).status_code == 404
    assert (await client.get(f"/api/timeline-sections/")).json() == []