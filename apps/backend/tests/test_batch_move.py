import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task
from app.models.user import User


async def _create_task(client: AsyncClient, title: str, **overrides):
    return (await client.post("/api/tasks/", json={"title": title, **overrides})).json()


async def _seed_task(session: AsyncSession, user_id, title: str) -> Task:
    task = Task(id=uuid4(), user_id=user_id, title=title, status="todo")
    session.add(task)
    await session.flush()
    return task


@pytest.mark.asyncio
async def test_batch_free_section_move_keeps_status(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Ideas"})).json()
    t1 = await _create_task(client, "A", status="todo")
    t2 = await _create_task(client, "B", status="in_progress")

    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [t1["id"], t2["id"]], "section_id": section["id"], "index": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["moved"] == 2

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    section_tasks = [t for t in tasks if t.get("board_section_id") == section["id"]]
    section_tasks.sort(key=lambda t: t["board_order"])
    assert [t["title"] for t in section_tasks] == ["A", "B"]
    assert all(t["status"] in ("todo", "in_progress") for t in section_tasks)


@pytest.mark.asyncio
async def test_batch_status_section_move_sets_status_and_renumbers_once(client: AsyncClient):
    await client.get("/api/board-sections/?kind=kanban")
    sections = (await client.get("/api/board-sections/?kind=kanban")).json()
    todo = next(s for s in sections if s["status"] == "todo")

    t1 = await _create_task(client, "A", status="in_progress")
    t2 = await _create_task(client, "B", status="in_progress")
    t3 = await _create_task(client, "C", status="backlog")

    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [t1["id"], t2["id"]], "section_id": todo["id"], "index": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["moved"] == 2

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    status_tasks = [t for t in tasks if t.get("status") == "todo"]
    status_tasks.sort(key=lambda t: t["board_order"])
    assert [t["title"] for t in status_tasks] == ["A", "B"]
    assert all(t["board_section_id"] is None for t in status_tasks)


@pytest.mark.asyncio
async def test_batch_move_preserves_group_order_and_index(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    t1 = await _create_task(client, "One")
    t2 = await _create_task(client, "Two")
    t3 = await _create_task(client, "Three")
    t4 = await _create_task(client, "Four")
    for t in [t1, t2, t3]:
        await client.post(
            "/api/tasks/board-move",
            json={"task_id": t["id"], "section_id": section["id"], "index": 0},
        )

    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [t3["id"], t2["id"]], "section_id": section["id"], "index": 1},
    )
    assert resp.status_code == 200

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    section_tasks = [t for t in tasks if t.get("board_section_id") == section["id"]]
    section_tasks.sort(key=lambda t: t["board_order"])
    # index=1 splice of [Three, Two] into existing [One, ...] -> [One, Three, Two]
    assert [t["title"] for t in section_tasks] == ["One", "Three", "Two"]


@pytest.mark.asyncio
async def test_batch_move_to_unsorted_clears_section(client: AsyncClient):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    t1 = await _create_task(client, "A")
    t2 = await _create_task(client, "B")
    for t in [t1, t2]:
        await client.post(
            "/api/tasks/board-move",
            json={"task_id": t["id"], "section_id": section["id"], "index": 0},
        )

    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [t1["id"], t2["id"]], "section_id": None, "index": 0},
    )
    assert resp.status_code == 200

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    assert all(t["board_section_id"] is None for t in tasks if t["title"] in ("A", "B"))


@pytest.mark.asyncio
async def test_batch_move_foreign_task_404(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="foreign-batch@test", password_hash="x")
    db_session.add(other)
    await db_session.flush()
    # A real task owned by a second user: batching it together with an owned one
    # must fail closed (strict 404) and never touch the foreign task.
    foreign = await _seed_task(db_session, other.id, "Foreign")
    await db_session.commit()

    mine = await _create_task(client, "Mine")
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Col"})).json()
    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [mine["id"], str(foreign.id)], "section_id": section["id"], "index": 0},
    )
    assert resp.status_code == 404

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    assert all(t["title"] != "Foreign" for t in tasks)


@pytest.mark.asyncio
async def test_batch_move_size_cap(client: AsyncClient):
    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [str(uuid4()) for _ in range(101)], "section_id": None, "index": 0},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_batch_move_missing_section_404(client: AsyncClient):
    task = (await client.post("/api/tasks/", json={"title": "Orphan"})).json()
    resp = await client.post(
        "/api/tasks/batch-board-move",
        json={"task_ids": [task["id"]], "section_id": "00000000-0000-0000-0000-000000000000", "index": 0},
    )
    assert resp.status_code == 404