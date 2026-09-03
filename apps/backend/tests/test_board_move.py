import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_section import BoardSection
from app.models.user import User


async def _create_task(client: AsyncClient, title: str, **overrides):
    return (await client.post("/api/tasks/", json={"title": title, **overrides})).json()


@pytest.mark.asyncio
async def test_free_section_move_keeps_status(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Ideas"})).json()
    task = await _create_task(client, "Free task", status="todo")

    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": section["id"], "index": 0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["board_section_id"] == section["id"]
    assert data["status"] == "todo"  # status untouched by free sections
    assert data["board_order"] == 0


@pytest.mark.asyncio
async def test_status_section_move_sets_status_and_clears_section(client: AsyncClient):
    await client.get("/api/board-sections/?kind=kanban")  # seed defaults
    sections = (await client.get("/api/board-sections/?kind=kanban")).json()
    done = next(s for s in sections if s["status"] == "done")

    task = await _create_task(client, "Do it")
    free = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Free"})).json()
    await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": free["id"], "index": 0},
    )

    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": done["id"], "index": 0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "done"
    assert data["board_section_id"] is None
    assert data["board_order"] == 0


@pytest.mark.asyncio
async def test_reorder_renumbers_board_order(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    t1 = await _create_task(client, "One")
    t2 = await _create_task(client, "Two")
    t3 = await _create_task(client, "Three")
    for i, t in enumerate([t1, t2, t3]):
        await client.post(
            "/api/tasks/board-move",
            json={"task_id": t["id"], "section_id": section["id"], "index": i},
        )

    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": t3["id"], "section_id": section["id"], "index": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["board_order"] == 0

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    section_tasks = [t for t in tasks if t.get("board_section_id") == section["id"]]
    section_tasks.sort(key=lambda t: t["board_order"])
    assert [t["title"] for t in section_tasks] == ["Three", "One", "Two"]


@pytest.mark.asyncio
async def test_unsorted_move_clears_section(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    task = await _create_task(client, "Go free", status="in_progress")
    await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": section["id"], "index": 0},
    )

    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": None, "index": 0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["board_section_id"] is None
    assert data["status"] == "in_progress"  # Unsorted never touches status


@pytest.mark.asyncio
async def test_index_out_of_range_clamps(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    t1 = await _create_task(client, "One")
    t2 = await _create_task(client, "Two")
    for t in [t1, t2]:
        await client.post(
            "/api/tasks/board-move",
            json={"task_id": t["id"], "section_id": section["id"], "index": 0},
        )
    # index beyond the sibling count must clamp to the end, not 500
    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": t2["id"], "section_id": section["id"], "index": 99},
    )
    assert resp.status_code == 200
    assert resp.json()["board_order"] == 1


@pytest.mark.asyncio
async def test_missing_task_404(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": "00000000-0000-0000-0000-000000000000", "section_id": section["id"], "index": 0},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_missing_section_404(client: AsyncClient):
    task = await _create_task(client, "Orphan")
    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": "00000000-0000-0000-0000-000000000000", "index": 0},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_cross_user_section_404(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="cross-section@test", password_hash="x")
    db_session.add(other)
    await db_session.flush()
    other_section = BoardSection(user_id=other.id, kind="board", title="Secret", position=0)
    db_session.add(other_section)
    await db_session.commit()

    task = await _create_task(client, "Mine")
    resp = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": str(other_section.id), "index": 0},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_task_pins_to_section(client: AsyncClient):
    """Creating a task with board_section_id must pin it to the free section
    (the kanban/board add-card path), not silently drop the field."""
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Ideas"})).json()
    resp = await client.post("/api/tasks/", json={
        "title": "Pinned at create",
        "status": "todo",
        "board_section_id": section["id"],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["board_section_id"] == section["id"]
    assert data["status"] == "todo"  # free sections never touch status
    assert data["board_order"] is None


@pytest.mark.asyncio
async def test_create_task_rejects_foreign_section(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="create-foreign@test", password_hash="x")
    db_session.add(other)
    await db_session.flush()
    other_section = BoardSection(user_id=other.id, kind="board", title="Secret", position=0)
    db_session.add(other_section)
    await db_session.commit()

    resp = await client.post("/api/tasks/", json={
        "title": "Hijack",
        "board_section_id": str(other_section.id),
    })
    assert resp.status_code == 404
