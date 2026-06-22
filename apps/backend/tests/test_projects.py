import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_project(client: AsyncClient):
    response = await client.post("/api/projects/", json={
        "name": "Work",
        "color": "#ff0000",
    })
    assert response.status_code == 200
    assert response.json()["name"] == "Work"


@pytest.mark.asyncio
async def test_create_project_empty_name(client: AsyncClient):
    response = await client.post("/api/projects/", json={"name": ""})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_project_long_name(client: AsyncClient):
    response = await client.post("/api/projects/", json={"name": "x" * 256})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_project_duplicate_name(client: AsyncClient):
    await client.post("/api/projects/", json={"name": "Dup"})
    response = await client.post("/api/projects/", json={"name": "Dup"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_list_projects(client: AsyncClient):
    await client.post("/api/projects/", json={"name": "P1"})
    await client.post("/api/projects/", json={"name": "P2"})

    response = await client.get("/api/projects/")
    assert response.status_code == 200
    assert len(response.json()) >= 2


@pytest.mark.asyncio
async def test_get_project(client: AsyncClient):
    created = await client.post("/api/projects/", json={"name": "GetMe"})
    pid = created.json()["id"]

    response = await client.get(f"/api/projects/{pid}")
    assert response.status_code == 200
    assert response.json()["name"] == "GetMe"


@pytest.mark.asyncio
async def test_get_project_not_found(client: AsyncClient):
    response = await client.get("/api/projects/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_project(client: AsyncClient):
    created = await client.post("/api/projects/", json={"name": "Old"})
    pid = created.json()["id"]

    response = await client.patch(f"/api/projects/{pid}", json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


@pytest.mark.asyncio
async def test_delete_project(client: AsyncClient):
    created = await client.post("/api/projects/", json={"name": "Del"})
    pid = created.json()["id"]

    response = await client.delete(f"/api/projects/{pid}")
    assert response.status_code == 200

    response = await client.get(f"/api/projects/{pid}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_project_with_tasks(client: AsyncClient):
    proj = await client.post("/api/projects/", json={"name": "WithTasks"})
    pid = proj.json()["id"]

    await client.post("/api/tasks/", json={"title": "Project Task", "project_id": pid})
    response = await client.delete(f"/api/projects/{pid}")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_project_task_count(client: AsyncClient):
    proj = await client.post("/api/projects/", json={"name": "Counted"})
    pid = proj.json()["id"]

    await client.post("/api/tasks/", json={"title": "T1", "project_id": pid})
    await client.post("/api/tasks/", json={"title": "T2", "project_id": pid})

    response = await client.get(f"/api/projects/{pid}")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Counted"
