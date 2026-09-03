import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_section import BoardSection
from app.models.task import Task
from app.models.user import User


@pytest.mark.asyncio
async def test_lazy_seeds_default_kanban_sections(client: AsyncClient):
    resp = await client.get("/api/board-sections/?kind=kanban")
    assert resp.status_code == 200
    sections = resp.json()
    assert len(sections) == 4
    assert {s["status"] for s in sections} == {"backlog", "todo", "in_progress", "done"}
    assert [s["title"] for s in sections] == ["Backlog", "To Do", "In Progress", "Done"]
    assert [s["color"] for s in sections] == ["#9E9E9E", "#4FC3F7", "#FFA726", "#66BB6A"]


@pytest.mark.asyncio
async def test_board_kind_starts_empty(client: AsyncClient):
    resp = await client.get("/api/board-sections/?kind=board")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_invalid_kind_rejected(client: AsyncClient):
    assert (await client.get("/api/board-sections/?kind=nope")).status_code == 422


@pytest.mark.asyncio
async def test_create_free_section(client: AsyncClient):
    resp = await client.post("/api/board-sections/", json={
        "kind": "board", "title": "Ideas", "color": "#ff0000",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Ideas"
    assert data["color"] == "#ff0000"
    assert data["status"] is None
    assert data["position"] == 0


@pytest.mark.asyncio
async def test_status_section_upserts(client: AsyncClient):
    await client.get("/api/board-sections/?kind=kanban")  # seed defaults
    resp = await client.post("/api/board-sections/", json={
        "kind": "kanban", "title": "WIP", "color": "#123456", "status": "in_progress",
    })
    assert resp.status_code == 200
    assert resp.json()["title"] == "WIP"
    assert resp.json()["color"] == "#123456"
    sections = (await client.get("/api/board-sections/?kind=kanban")).json()
    assert len(sections) == 4  # upserted, not inserted
    wip = next(s for s in sections if s["status"] == "in_progress")
    assert wip["title"] == "WIP"


@pytest.mark.asyncio
async def test_invalid_status_rejected(client: AsyncClient):
    resp = await client.post("/api/board-sections/", json={
        "kind": "kanban", "title": "X", "status": "bogus",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_section(client: AsyncClient):
    created = (await client.post("/api/board-sections/", json={"kind": "board", "title": "A", "color": "#111111"})).json()
    resp = await client.patch(
        f"/api/board-sections/{created['id']}",
        json={"title": "B", "color": "#222222", "position": 5},
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "B"
    assert resp.json()["color"] == "#222222"
    assert resp.json()["position"] == 5
    assert resp.json()["status"] is None


@pytest.mark.asyncio
async def test_patch_unknown_section_404(client: AsyncClient):
    resp = await client.patch("/api/board-sections/00000000-0000-0000-0000-000000000000", json={"title": "Ghost"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section_clears_membership(client: AsyncClient, db_session: AsyncSession):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Drop"})).json()
    task = (await client.post("/api/tasks/", json={"title": "Pinned"})).json()
    moved = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": section["id"], "index": 0},
    )
    assert moved.status_code == 200
    assert moved.json()["board_section_id"] == section["id"]

    assert (await client.delete(f"/api/board-sections/{section['id']}")).status_code == 200

    fetched = (
        await db_session.execute(select(Task).where(Task.id == task["id"]))
    ).scalar_one()
    assert fetched.board_section_id is None


@pytest.mark.asyncio
async def test_cross_user_isolation(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="section-other@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_section = BoardSection(user_id=other.id, kind="board", title="Secret", color="#000000", position=0)
    db_session.add(other_section)
    await db_session.commit()

    resp = await client.get("/api/board-sections/?kind=board")
    assert all(s["id"] != str(other_section.id) for s in resp.json())

    assert (await client.patch(f"/api/board-sections/{other_section.id}", json={"title": "hacked"})).status_code == 404
    assert (await client.delete(f"/api/board-sections/{other_section.id}")).status_code == 404


@pytest.mark.asyncio
async def test_position_ordering(client: AsyncClient):
    for i, title in enumerate(["First", "Second", "Third"]):
        resp = await client.post("/api/board-sections/", json={"kind": "board", "title": title})
        assert resp.status_code == 200
        assert resp.json()["position"] == i
    resp = await client.get("/api/board-sections/?kind=board")
    assert [s["title"] for s in resp.json()] == ["First", "Second", "Third"]
