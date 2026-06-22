import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_tag(client: AsyncClient):
    response = await client.post("/api/tags/", json={
        "name": "urgent",
        "color": "#ff0000",
    })
    assert response.status_code == 200
    assert response.json()["name"] == "urgent"


@pytest.mark.asyncio
async def test_create_tag_empty_name(client: AsyncClient):
    response = await client.post("/api/tags/", json={"name": ""})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_tag_duplicate(client: AsyncClient):
    await client.post("/api/tags/", json={"name": "unique"})
    response = await client.post("/api/tags/", json={"name": "unique"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_list_tags(client: AsyncClient):
    await client.post("/api/tags/", json={"name": "tag1"})
    await client.post("/api/tags/", json={"name": "tag2"})

    response = await client.get("/api/tags/")
    assert response.status_code == 200
    assert len(response.json()) >= 2


@pytest.mark.asyncio
async def test_get_tag(client: AsyncClient):
    created = await client.post("/api/tags/", json={"name": "getme"})
    tag_id = created.json()["id"]

    response = await client.get(f"/api/tags/{tag_id}")
    assert response.status_code == 200
    assert response.json()["name"] == "getme"


@pytest.mark.asyncio
async def test_get_tag_not_found(client: AsyncClient):
    response = await client.get("/api/tags/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_tag(client: AsyncClient):
    created = await client.post("/api/tags/", json={"name": "oldname"})
    tag_id = created.json()["id"]

    response = await client.patch(f"/api/tags/{tag_id}", json={"name": "newname"})
    assert response.status_code == 200
    assert response.json()["name"] == "newname"


@pytest.mark.asyncio
async def test_delete_tag(client: AsyncClient):
    created = await client.post("/api/tags/", json={"name": "deleteme"})
    tag_id = created.json()["id"]

    response = await client.delete(f"/api/tags/{tag_id}")
    assert response.status_code == 200

    response = await client.get(f"/api/tags/{tag_id}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_tag_task_association(client: AsyncClient):
    tag = await client.post("/api/tags/", json={"name": "bug"})
    tag_id = tag.json()["id"]

    task = await client.post("/api/tasks/", json={"title": "Fix bug"})
    task_id = task.json()["id"]

    assign = await client.post(f"/api/tags/tasks/{task_id}", params={"tag_id": tag_id})
    assert assign.status_code == 200

    tags = await client.get(f"/api/tags/tasks/{task_id}")
    assert tags.status_code == 200
    assert len(tags.json()) == 1
    assert tags.json()[0]["name"] == "bug"

    remove = await client.delete(f"/api/tags/tasks/{task_id}", params={"tag_id": tag_id})
    assert remove.status_code == 200

    tags_after = await client.get(f"/api/tags/tasks/{task_id}")
    assert len(tags_after.json()) == 0


@pytest.mark.asyncio
async def test_tag_task_create_with_tags(client: AsyncClient):
    tag = await client.post("/api/tags/", json={"name": "important"})
    tag_id = tag.json()["id"]

    task = await client.post("/api/tasks/", json={
        "title": "Task with tag",
        "tag_ids": [tag_id],
    })
    assert task.status_code == 200

    tags = await client.get(f"/api/tags/tasks/{task.json()['id']}")
    assert len(tags.json()) == 1
