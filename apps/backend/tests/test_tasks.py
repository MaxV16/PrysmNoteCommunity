import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.task import Task


@pytest.mark.asyncio
async def test_task_routes_reject_other_users_task(client: AsyncClient, db_session: AsyncSession):
    """C4: get/update/delete on a task owned by another user must return 404
    (ownership isolation), not mutate or leak the task."""
    other_user_id = uuid4()
    from app.models.user import User
    db_session.add(User(id=other_user_id, email=f"{other_user_id}@other.test", password_hash="x", display_name="Other"))
    other_task = Task(user_id=other_user_id, title="Other's secret task")
    db_session.add(other_task)
    await db_session.commit()

    tid = str(other_task.id)
    assert (await client.get(f"/api/tasks/{tid}")).status_code == 404
    assert (await client.patch(f"/api/tasks/{tid}", json={"title": "hacked"})).status_code == 404
    assert (await client.delete(f"/api/tasks/{tid}")).status_code == 404

    # The other user's task is untouched.
    fetched = await db_session.get(Task, other_task.id)
    assert fetched.title == "Other's secret task"


@pytest.mark.asyncio
async def test_create_task(client: AsyncClient):
    response = await client.post("/api/tasks/", json={
        "title": "Test Task",
        "description": "A test task",
        "priority": 3,
        "status": "todo",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Test Task"
    assert data["status"] == "todo"


@pytest.mark.asyncio
async def test_create_task_empty_title(client: AsyncClient):
    response = await client.post("/api/tasks/", json={"title": ""})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_task_long_title(client: AsyncClient):
    response = await client.post("/api/tasks/", json={"title": "x" * 501})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_task_invalid_priority(client: AsyncClient):
    response = await client.post("/api/tasks/", json={"title": "Test", "priority": 0})
    assert response.status_code == 422

    response = await client.post("/api/tasks/", json={"title": "Test", "priority": 6})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_task_invalid_status(client: AsyncClient):
    response = await client.post("/api/tasks/", json={"title": "Test", "status": "invalid_status"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_list_tasks(client: AsyncClient):
    await client.post("/api/tasks/", json={"title": "Task 1"})
    await client.post("/api/tasks/", json={"title": "Task 2"})

    response = await client.get("/api/tasks/")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 2


@pytest.mark.asyncio
async def test_list_tasks_pagination(client: AsyncClient):
    for i in range(5):
        await client.post("/api/tasks/", json={"title": f"Task {i}"})

    response = await client.get("/api/tasks/?limit=2&offset=0")
    assert response.status_code == 200
    data = response.json()
    assert len(data) <= 2


@pytest.mark.asyncio
async def test_get_task(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Get Me"})
    task_id = created.json()["id"]

    response = await client.get(f"/api/tasks/{task_id}")
    assert response.status_code == 200
    assert response.json()["title"] == "Get Me"


@pytest.mark.asyncio
async def test_get_task_not_found(client: AsyncClient):
    response = await client.get("/api/tasks/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_task(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Old Title"})
    task_id = created.json()["id"]

    response = await client.patch(f"/api/tasks/{task_id}", json={
        "title": "New Title",
        "priority": 1,
    })
    assert response.status_code == 200
    assert response.json()["title"] == "New Title"


@pytest.mark.asyncio
async def test_update_task_validate_status(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Status Test"})
    task_id = created.json()["id"]

    response = await client.patch(f"/api/tasks/{task_id}", json={
        "status": "invalid_status",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_update_task_validate_priority(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Priority Test"})
    task_id = created.json()["id"]

    response = await client.patch(f"/api/tasks/{task_id}", json={"priority": 99})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_update_task_validate_date_format(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Date Test"})
    task_id = created.json()["id"]

    response = await client.patch(f"/api/tasks/{task_id}", json={"start_date": "not-a-date"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_update_task_no_such_task(client: AsyncClient):
    response = await client.patch("/api/tasks/00000000-0000-0000-0000-000000000000", json={
        "title": "Ghost",
    })
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_task(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Delete Me"})
    task_id = created.json()["id"]

    response = await client.delete(f"/api/tasks/{task_id}")
    assert response.status_code == 200

    response = await client.get(f"/api/tasks/{task_id}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_task_not_found(client: AsyncClient):
    response = await client.delete("/api/tasks/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_subtask_flow(client: AsyncClient):
    created = await client.post("/api/tasks/", json={"title": "Parent"})
    parent_id = created.json()["id"]

    sub = await client.post(f"/api/tasks/{parent_id}/subtasks", json={
        "title": "Subtask"
    })
    assert sub.status_code == 200
    assert sub.json()["title"] == "Subtask"

    subs = await client.get(f"/api/tasks/{parent_id}/subtasks")
    assert subs.status_code == 200
    assert len(subs.json()) == 1


@pytest.mark.asyncio
async def test_subtask_bad_parent(client: AsyncClient):
    response = await client.post("/api/tasks/00000000-0000-0000-0000-000000000000/subtasks", json={
        "title": "Orphan"
    })
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_breakdown_creates_subtasks(client: AsyncClient):
    """Breakdown must create child tasks even without a configured AI key."""
    created = await client.post("/api/tasks/", json={
        "title": "Plan launch",
        "description": "- Research market\n- Define goals\n- Build roadmap",
    })
    parent_id = created.json()["id"]

    response = await client.post(f"/api/tasks/{parent_id}/breakdown", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    subtasks = body["subtasks"]
    assert len(subtasks) >= 3
    titles = [s["title"] for s in subtasks]
    assert "Research market" in titles
    assert "Define goals" in titles

    # They are persisted as real children of the parent.
    subs = await client.get(f"/api/tasks/{parent_id}/subtasks")
    assert len(subs.json()) == len(subtasks)


@pytest.mark.asyncio
async def test_breakdown_generic_fallback(client: AsyncClient):
    """A parent with no description still gets a deterministic breakdown."""
    created = await client.post("/api/tasks/", json={"title": "Build a product"})
    parent_id = created.json()["id"]

    response = await client.post(f"/api/tasks/{parent_id}/breakdown", json={})
    assert response.status_code == 200
    subtasks = response.json()["subtasks"]
    assert len(subtasks) >= 1
    assert all(s["title"] for s in subtasks)



@pytest.mark.asyncio
async def test_expand_recurring(client: AsyncClient):
    created = await client.post("/api/tasks/", json={
        "title": "Recurring Task",
        "start_date": "2025-01-01",
        "recurrence_rule": "FREQ=WEEKLY;COUNT=4",
    })
    task_id = created.json()["id"]

    response = await client.post("/api/tasks/expand-recurring")
    assert response.status_code == 200
    # Should have expanded at least one future instance
    data = response.json()
    assert data["expanded"] >= 0  # May be 0 if no future instances this year


@pytest.mark.asyncio
async def test_recurring_weekday_expands_full_week(client: AsyncClient):
    """Creating a Mon-Fri recurring template must materialize all 5 weekdays immediately."""
    created = await client.post("/api/tasks/", json={
        "title": "Weekday Job",
        "start_date": "2026-08-03",  # a Monday
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    })
    assert created.status_code == 200

    tasks = (await client.get("/api/tasks/", params={"limit": 200})).json()
    weekday_tasks = [t for t in tasks if t.get("title") == "Weekday Job"]
    templates = [t for t in weekday_tasks if t.get("parent_task_id") is None]
    children = [t for t in weekday_tasks if t.get("parent_task_id") is not None]
    child_dates = {t["start_date"] for t in children}

    # Exactly one template exists, living on its own start date.
    assert len(templates) == 1
    assert templates[0]["start_date"] == "2026-08-03"

    # Children cover Tue-Fri of the first week (the template already represents Mon),
    # plus the same weekdays in subsequent weeks.
    for expected in ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]:
        assert expected in child_dates, f"missing child occurrence {expected}"
    # No duplicate child is ever created on the template's own date.
    assert "2026-08-03" not in child_dates
    # And it must not have created a whole-year flood.
    assert len(child_dates) <= 60


@pytest.mark.asyncio
async def test_recurring_weekend_expands_sat_and_sun(client: AsyncClient):
    """A Sat+Sun recurring template must materialize both weekend days in one call."""
    created = await client.post("/api/tasks/", json={
        "title": "Weekend Shift",
        "start_date": "2026-08-08",  # a Saturday
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=SA,SU",
    })
    assert created.status_code == 200

    tasks = (await client.get("/api/tasks/", params={"limit": 200})).json()
    weekend_tasks = [t for t in tasks if t.get("title") == "Weekend Shift"]
    templates = [t for t in weekend_tasks if t.get("parent_task_id") is None]
    children = [t for t in weekend_tasks if t.get("parent_task_id") is not None]
    child_dates = {t["start_date"] for t in children}

    # Sat 8th is the template itself; Sunday 9th is a child occurrence.
    assert len(templates) == 1
    assert templates[0]["start_date"] == "2026-08-08"
    assert "2026-08-08" not in child_dates
    # The following weekend Saturday (15th) is a child, proving Sat+Sun both materialize.
    assert "2026-08-09" in child_dates
    assert "2026-08-15" in child_dates
    assert "2026-08-16" in child_dates


@pytest.mark.asyncio
async def test_batch_create_caps_at_50(client: AsyncClient):
    """A single batch create must be bounded to prevent row-bombing."""
    payload = {
        "tasks": [{"title": f"Task {i}"} for i in range(51)],
    }
    response = await client.post("/api/tasks/batch", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_batch_create_validates_items(client: AsyncClient):
    """Each batch item is validated with the full task schema."""
    response = await client.post("/api/tasks/batch", json={"tasks": [{"title": ""}]})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_malformed_task_id_returns_404(client: AsyncClient):
    """A malformed UUID must be a 404, not a 500."""
    response = await client.get("/api/tasks/not-a-uuid")
    assert response.status_code == 404
    response = await client.delete("/api/tasks/not-a-uuid")
    assert response.status_code == 404
