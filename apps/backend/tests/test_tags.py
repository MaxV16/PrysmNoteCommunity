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
async def test_tag_operations_on_trashed_task_404(client: AsyncClient):
    """Tag assignment/removal/list against a soft-deleted (trashed) task must
    404 - a trashed task is out of every normal task surface, so tagging it back
    into existance from memory would resurface it inconsistently."""
    tag = (await client.post("/api/tags/", json={"name": "ghosttag"})).json()
    task = (await client.post("/api/tasks/", json={"title": "Zombie"})).json()
    assert (await client.delete(f"/api/tasks/{task['id']}")).status_code == 200

    assign = await client.post(f"/api/tags/tasks/{task['id']}", params={"tag_id": tag["id"]})
    assert assign.status_code == 404

    list_tags = await client.get(f"/api/tags/tasks/{task['id']}")
    assert list_tags.status_code == 404


@pytest.mark.asyncio
async def test_tag_task_create_with_tags(client: AsyncClient):
    tag = await client.post("/api/tags/", json={"name": "important"})
    tag_id = tag.json()["id"]

    task = await client.post("/api/tasks/", json={
        "title": "Task with tag",
        "tag_ids": [tag_id],
    })

    tags = await client.get(f"/api/tags/tasks/{task.json()['id']}")
    assert len(tags.json()) == 1


@pytest.mark.asyncio
async def test_create_task_response_includes_tags(client: AsyncClient):
    """POST /api/tasks/ with tag_ids must return the assigned tags inline."""
    tag = (await client.post("/api/tags/", json={"name": "inline", "color": "#ff0000"})).json()
    task = (await client.post("/api/tasks/", json={
        "title": "Tagged on create",
        "tag_ids": [tag["id"]],
    })).json()
    assert [t["name"] for t in task["tags"]] == ["inline"]
    assert task["tags"][0]["color"] == "#ff0000"
    assert task["tags"][0]["id"] == tag["id"]


@pytest.mark.asyncio
async def test_list_tasks_includes_tags(client: AsyncClient):
    """GET /api/tasks/ must carry tags on every serialized task."""
    tag = (await client.post("/api/tags/", json={"name": "listed"})).json()
    task = (await client.post("/api/tasks/", json={
        "title": "Visible tag",
        "tag_ids": [tag["id"]],
    })).json()

    listed = (await client.get("/api/tasks/")).json()
    row = next(t for t in listed if t["id"] == task["id"])
    assert [t["name"] for t in row["tags"]] == ["listed"]

    single = (await client.get(f"/api/tasks/{task['id']}")).json()
    assert [t["name"] for t in single["tags"]] == ["listed"]


@pytest.mark.asyncio
async def test_update_task_tag_ids_round_trips(client: AsyncClient):
    """PATCH with tag_ids must persist AND echo the new tag set back."""
    task = (await client.post("/api/tasks/", json={"title": "Retag me"})).json()
    tag = (await client.post("/api/tags/", json={"name": "updated"})).json()

    updated = (await client.patch(f"/api/tasks/{task['id']}", json={
        "tag_ids": [tag["id"]],
    })).json()
    assert [t["name"] for t in updated["tags"]] == ["updated"]

    cleared = (await client.patch(f"/api/tasks/{task['id']}", json={"tag_ids": []})).json()
    assert cleared["tags"] == []
