import pytest
from httpx import AsyncClient
from uuid import uuid4


async def _create_task(client: AsyncClient, title: str, **overrides):
    return (await client.post("/api/tasks/", json={"title": title, **overrides})).json()


@pytest.mark.asyncio
async def test_batch_reschedule_shifts_dated_tasks(client: AsyncClient):
    t1 = await _create_task(client, "A", start_date="2026-01-10", due_date="2026-01-12")
    t2 = await _create_task(client, "B", start_date="2026-02-01")

    resp = await client.post(
        "/api/tasks/batch-reschedule",
        json={"task_ids": [t1["id"], t2["id"]], "delta_days": 3},
    )
    assert resp.status_code == 200
    assert resp.json()["rescheduled"] == 2

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    by_id = {t["id"]: t for t in tasks}
    assert by_id[t1["id"]]["start_date"] == "2026-01-13"
    assert by_id[t1["id"]]["due_date"] == "2026-01-15"
    assert by_id[t2["id"]]["start_date"] == "2026-02-04"
    assert by_id[t2["id"]]["due_date"] is None


@pytest.mark.asyncio
async def test_batch_reschedule_undated_tasks_land_on_today_plus_delta(client: AsyncClient):
    from datetime import date, timedelta

    t1 = await _create_task(client, "Undated A")
    t2 = await _create_task(client, "Undated B")

    resp = await client.post(
        "/api/tasks/batch-reschedule",
        json={"task_ids": [t1["id"], t2["id"]], "delta_days": 2},
    )
    assert resp.status_code == 200
    assert resp.json()["rescheduled"] == 2

    target = (date.today() + timedelta(days=2)).isoformat()
    tasks = (await client.get("/api/tasks/?limit=200")).json()
    by_id = {t["id"]: t for t in tasks}
    assert by_id[t1["id"]]["start_date"] == target
    assert by_id[t1["id"]]["due_date"] == target
    assert by_id[t2["id"]]["start_date"] == target


@pytest.mark.asyncio
async def test_batch_reschedule_negative_delta(client: AsyncClient):
    t = await _create_task(client, "Shrink", start_date="2026-05-01", due_date="2026-05-05")
    resp = await client.post(
        "/api/tasks/batch-reschedule",
        json={"task_ids": [t["id"]], "delta_days": -2},
    )
    assert resp.status_code == 200

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    moved = next(x for x in tasks if x["id"] == t["id"])
    assert moved["start_date"] == "2026-04-29"
    assert moved["due_date"] == "2026-05-03"


@pytest.mark.asyncio
async def test_batch_reschedule_size_cap(client: AsyncClient):
    resp = await client.post(
        "/api/tasks/batch-reschedule",
        json={"task_ids": [str(uuid4()) for _ in range(101)], "delta_days": 1},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_batch_reschedule_zero_delta_is_noop(client: AsyncClient):
    from datetime import date, timedelta

    t = await _create_task(client, "Static", start_date="2026-06-01")
    resp = await client.post(
        "/api/tasks/batch-reschedule",
        json={"task_ids": [t["id"]], "delta_days": 0},
    )
    assert resp.status_code == 200
    tasks = (await client.get("/api/tasks/?limit=200")).json()
    assert next(x for x in tasks if x["id"] == t["id"])["start_date"] == "2026-06-01"


@pytest.mark.asyncio
async def test_batch_set_date_assigns_same_day(client: AsyncClient):
    t1 = await _create_task(client, "A", start_date="2026-01-10", due_date="2026-01-12")
    t2 = await _create_task(client, "B")

    resp = await client.post(
        "/api/tasks/batch-set-date",
        json={"task_ids": [t1["id"], t2["id"]], "date": "2026-03-15"},
    )
    assert resp.status_code == 200
    assert resp.json()["updated"] == 2

    tasks = (await client.get("/api/tasks/?limit=200")).json()
    by_id = {t["id"]: t for t in tasks}
    assert by_id[t1["id"]]["start_date"] == "2026-03-15"
    assert by_id[t1["id"]]["due_date"] == "2026-03-15"
    assert by_id[t2["id"]]["start_date"] == "2026-03-15"
    assert by_id[t2["id"]]["due_date"] == "2026-03-15"


@pytest.mark.asyncio
async def test_batch_set_date_invalid_date_422(client: AsyncClient):
    t = await _create_task(client, "A")
    resp = await client.post(
        "/api/tasks/batch-set-date",
        json={"task_ids": [t["id"]], "date": "not-a-date"},
    )
    assert resp.status_code == 422