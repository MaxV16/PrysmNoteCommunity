import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


async def _create_task(client: AsyncClient, title: str, **overrides):
    return (await client.post("/api/tasks/", json={"title": title, **overrides})).json()


@pytest.mark.asyncio
async def test_batch_delete_deletes_owned_tasks(client: AsyncClient):
    t1 = await _create_task(client, "A")
    t2 = await _create_task(client, "B")

    resp = await client.post("/api/tasks/batch-delete", json={"task_ids": [t1["id"], t2["id"]]})
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 2

    resp1 = await client.get(f"/api/tasks/{t1['id']}")
    assert resp1.status_code == 404
    resp2 = await client.get(f"/api/tasks/{t2['id']}")
    assert resp2.status_code == 404


@pytest.mark.asyncio
async def test_batch_delete_skips_foreign_tasks(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="foreign-delete@test", password_hash="x")
    db_session.add(other)
    await db_session.flush()
    await db_session.commit()

    mine = await _create_task(client, "Mine")
    resp = await client.post(
        "/api/tasks/batch-delete",
        json={"task_ids": [mine["id"], str(uuid4())]},
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 1

    still = await client.get(f"/api/tasks/{mine['id']}")
    assert still.status_code == 404


@pytest.mark.asyncio
async def test_batch_delete_size_cap(client: AsyncClient):
    resp = await client.post(
        "/api/tasks/batch-delete",
        json={"task_ids": [str(uuid4()) for _ in range(101)]},
    )
    assert resp.status_code == 422