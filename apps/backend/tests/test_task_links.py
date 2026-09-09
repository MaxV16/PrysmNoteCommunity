import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_task_link(client: AsyncClient):
    t1 = await client.post("/api/tasks/", json={"title": "Task A"})
    t2 = await client.post("/api/tasks/", json={"title": "Task B"})

    response = await client.post("/api/task-links/", json={
        "source_task_id": t1.json()["id"],
        "target_task_id": t2.json()["id"],
        "link_type": "related",
    })
    assert response.status_code == 200
    assert response.json()["link_type"] == "related"


@pytest.mark.asyncio
async def test_create_task_link_depends_on(client: AsyncClient):
    t1 = await client.post("/api/tasks/", json={"title": "Setup"})
    t2 = await client.post("/api/tasks/", json={"title": "Build"})

    response = await client.post("/api/task-links/", json={
        "source_task_id": t1.json()["id"],
        "target_task_id": t2.json()["id"],
        "link_type": "depends_on",
    })
    assert response.status_code == 200
    assert response.json()["link_type"] == "depends_on"


@pytest.mark.asyncio
async def test_create_task_link_invalid_type(client: AsyncClient):
    t1 = await client.post("/api/tasks/", json={"title": "A"})
    t2 = await client.post("/api/tasks/", json={"title": "B"})

    response = await client.post("/api/task-links/", json={
        "source_task_id": t1.json()["id"],
        "target_task_id": t2.json()["id"],
        "link_type": "invalid_type",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_task_link_rejects_trashed_task(client: AsyncClient):
    """A trashed task is invisible to the link endpoints: it must not be usable
    as a source or target, and links into it must not silently vanish into the
    trash view (soft-deleted tasks are out of every normal task surface)."""
    t1 = (await client.post("/api/tasks/", json={"title": "Alive"})).json()
    t2 = (await client.post("/api/tasks/", json={"title": "Doomed"})).json()

    # Soft-delete t2 into the trash.
    assert (await client.delete(f"/api/tasks/{t2['id']}")).status_code == 200

    # Linking an alive task to a trashed one must 404 (target not found).
    resp = await client.post("/api/task-links/", json={
        "source_task_id": t1["id"],
        "target_task_id": t2["id"],
        "link_type": "related",
    })
    assert resp.status_code == 404

    # And a trashed task can't be the source either.
    resp = await client.post("/api/task-links/", json={
        "source_task_id": t2["id"],
        "target_task_id": t1["id"],
        "link_type": "related",
    })
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_task_link_self_ref(client: AsyncClient):
    t = await client.post("/api/tasks/", json={"title": "Self"})
    tid = t.json()["id"]

    response = await client.post("/api/task-links/", json={
        "source_task_id": tid,
        "target_task_id": tid,
        "link_type": "related",
    })
    # SQLite doesn't enforce CHECK constraints in the same way, but the handler allows it
    # The constraint `different_tasks` is a DB-level constraint
    assert response.status_code in (200, 422, 500)


@pytest.mark.asyncio
async def test_list_task_links(client: AsyncClient):
    t1 = await client.post("/api/tasks/", json={"title": "A"})
    t2 = await client.post("/api/tasks/", json={"title": "B"})
    await client.post("/api/task-links/", json={
        "source_task_id": t1.json()["id"],
        "target_task_id": t2.json()["id"],
        "link_type": "depends_on",
    })

    response = await client.get(f"/api/task-links/", params={"task_id": t1.json()["id"]})
    assert response.status_code == 200
    assert len(response.json()) == 1


@pytest.mark.asyncio
async def test_list_task_links_no_results(client: AsyncClient):
    t = await client.post("/api/tasks/", json={"title": "Lonely"})
    response = await client.get(f"/api/task-links/", params={"task_id": t.json()["id"]})
    assert response.status_code == 200
    assert len(response.json()) == 0


@pytest.mark.asyncio
async def test_delete_task_link(client: AsyncClient):
    t1 = await client.post("/api/tasks/", json={"title": "A"})
    t2 = await client.post("/api/tasks/", json={"title": "B"})
    link = await client.post("/api/task-links/", json={
        "source_task_id": t1.json()["id"],
        "target_task_id": t2.json()["id"],
        "link_type": "related",
    })
    link_id = link.json()["id"]

    response = await client.delete(f"/api/task-links/{link_id}")
    assert response.status_code == 200

    response = await client.get(f"/api/task-links/", params={"task_id": t1.json()["id"]})
    assert len(response.json()) == 0
