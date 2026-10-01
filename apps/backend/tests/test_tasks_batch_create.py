"""Parity tests for bulk task creation.

``create_tasks_bulk`` replaced an N+1 loop over ``create_task`` (one ownership
query + one flush instead of one per row). These tests lock in the fields and
validation that the single-task path already guaranteed.
"""
from datetime import date
from uuid import uuid4

import pytest
from httpx import AsyncClient

from app.models.task_list import TaskList
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.task_service import create_tasks_bulk


@pytest.mark.asyncio
async def test_batch_create_applies_fields_and_default_list(client: AsyncClient):
    res = await client.post("/api/tasks/batch", json={"tasks": [
        {"title": "One", "priority": 1, "start_date": "2026-08-03", "due_date": "2026-08-05"},
        {"title": "Two"},
    ]})
    assert res.status_code == 200
    body = res.json()
    assert body["created"] == 2
    assert [t["title"] for t in body["tasks"]] == ["One", "Two"]

    listed = (await client.get("/api/tasks/", params={"limit": 200})).json()
    by_id = {t["id"]: t for t in listed}

    one = by_id[body["tasks"][0]["id"]]
    assert one["priority"] == 1
    assert one["start_date"] == "2026-08-03"
    assert one["due_date"] == "2026-08-05"

    two = by_id[body["tasks"][1]["id"]]
    assert two["title"] == "Two"
    assert two["status"] == "backlog"
    # CreateTaskRequest defaults priority to 3 (medium).
    assert two["priority"] == 3
    # Both landed on the same lazily-created default list.
    assert one["list_id"] == two["list_id"]
    assert one["list_id"] is not None


@pytest.mark.asyncio
async def test_batch_create_recurring_anchors_to_today_and_expands(client: AsyncClient):
    res = await client.post("/api/tasks/batch", json={"tasks": [
        {"title": "Daily standup", "recurrence_rule": "FREQ=DAILY"},
    ]})
    assert res.status_code == 200
    template = res.json()["tasks"][0]

    listed = (await client.get("/api/tasks/", params={"limit": 200})).json()
    family = [t for t in listed if t["title"] == "Daily standup"]
    roots = [t for t in family if t.get("parent_task_id") is None]

    # Exactly one template, anchored to today because no start_date was given.
    assert len(roots) == 1
    assert roots[0]["id"] == template["id"]
    assert roots[0]["start_date"] == date.today().isoformat()
    # And the recurring rule actually materialized occurrences.
    assert len(family) >= 2


@pytest.mark.asyncio
async def test_batch_create_validates_task_order(client: AsyncClient):
    """A due_date before its start_date is rejected, same as the single path."""
    res = await client.post("/api/tasks/batch", json={"tasks": [
        {"title": "Bad range", "start_date": "2026-08-10", "due_date": "2026-08-01"},
    ]})
    assert res.status_code in (400, 422)


@pytest.mark.asyncio
async def test_create_tasks_bulk_resolves_explicit_list_and_fields(db_session, ai_user):
    explicit = TaskList(user_id=ai_user, name="Work", position=1)
    db_session.add(explicit)
    await db_session.flush()

    created = await create_tasks_bulk(db_session, ai_user, [
        {"title": "A", "list_id": explicit.id, "status": "todo", "description": "note"},
        {"title": "B"},
    ])
    assert len(created) == 2
    assert created[0].list_id == explicit.id
    assert created[0].status == TaskStatus.TODO
    assert created[0].description == "note"
    # The task without an explicit list still lands on a real default list.
    assert created[1].list_id is not None
    assert created[1].list_id != explicit.id


@pytest.mark.asyncio
async def test_create_tasks_bulk_defaults_title_and_status(db_session, ai_user):
    created = await create_tasks_bulk(db_session, ai_user, [
        {"title": ""},
    ])
    assert created[0].title == "Untitled"
    assert created[0].status == TaskStatus.BACKLOG


@pytest.mark.asyncio
async def test_create_tasks_bulk_rejects_invalid_status(db_session, ai_user):
    """Same failure semantics as the single-task path (``_coerce_status``)."""
    with pytest.raises(ValueError):
        await create_tasks_bulk(db_session, ai_user, [
            {"title": "x", "status": "not-a-real-status"},
        ])


@pytest.mark.asyncio
async def test_create_tasks_bulk_rejects_unowned_list(db_session, ai_user):
    other = User(
        id=uuid4(), email=f"{uuid4()}@other.test",
        password_hash="x", display_name="Other",
    )
    db_session.add(other)
    await db_session.flush()
    foreign = TaskList(user_id=other.id, name="Foreign", position=1)
    db_session.add(foreign)
    await db_session.flush()

    with pytest.raises(ValueError, match="List not found"):
        await create_tasks_bulk(db_session, ai_user, [{"title": "Nope", "list_id": foreign.id}])

    # Nothing was persisted for the failed batch.
    from sqlalchemy import select
    rows = (await db_session.execute(
        select(Task).where(Task.user_id == ai_user, Task.title == "Nope")
    )).scalars().all()
    assert rows == []
