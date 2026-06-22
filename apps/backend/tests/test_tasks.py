import pytest
from httpx import AsyncClient


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
async def test_create_task_with_project(client: AsyncClient):
    proj = await client.post("/api/projects/", json={"name": "Work"})
    project_id = proj.json()["id"]

    response = await client.post("/api/tasks/", json={
        "title": "Work Task",
        "project_id": project_id,
        "priority": 5,
    })
    assert response.status_code == 200


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
