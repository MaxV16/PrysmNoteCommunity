import pytest


@pytest.mark.asyncio
async def test_create_and_list_team(client, test_user):
    res = await client.post("/api/teams/", json={"name": "Alpha"})
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Alpha"
    assert data["owner_id"] == str(test_user.id)
    assert len(data["members"]) == 1
    assert data["members"][0]["role"] == "owner"

    res = await client.get("/api/teams/")
    assert res.status_code == 200
    body = res.json()
    assert len(body["teams"]) == 1
    assert body["teams"][0]["name"] == "Alpha"


@pytest.mark.asyncio
async def test_invite_accept_flow(client, test_user, db_session):
    from uuid import uuid4
    from sqlalchemy import select
    from app.models.user import User
    from app.dependencies import get_current_user
    from app.main import app as fastapi_app

    # Second user receives + accepts the invite.
    user2 = User(id=uuid4(), email="member@example.com", password_hash="fake", display_name="Member")
    db_session.add(user2)
    await db_session.commit()

    team = (await client.post("/api/teams/", json={"name": "Beta"})).json()

    res = await client.post(f"/api/teams/{team['id']}/members", json={"email": "member@example.com"})
    assert res.status_code == 200
    assert res.json()["status"] == "invited"

    async def as_user2():
        return user2

    fastapi_app.dependency_overrides[get_current_user] = as_user2
    try:
        invites = (await client.get("/api/teams/")).json()["invites"]
        assert len(invites) == 1
        token = invites[0]["token"]
        res = await client.post(f"/api/teams/invites/{token}/accept")
    finally:
        fastapi_app.dependency_overrides[get_current_user] = lambda: test_user
    assert res.status_code == 200
    assert res.json()["status"] == "joined"

    detail = (await client.get(f"/api/teams/{team['id']}")).json()
    assert len(detail["members"]) == 2
    emails = {m["email"] for m in detail["members"]}
    assert "member@example.com" in emails


@pytest.mark.asyncio
async def test_share_task_and_list_team_tasks(client, test_user):
    team = (await client.post("/api/teams/", json={"name": "Gamma"})).json()
    task = (await client.post("/api/tasks/", json={"title": "Shared task", "status": "todo"})).json()

    res = await client.post(f"/api/teams/{team['id']}/share-task", json={"task_id": task["id"]})
    assert res.status_code == 200
    assert res.json()["status"] == "shared"

    res = await client.get(f"/api/teams/{team['id']}/tasks")
    assert res.status_code == 200
    titles = [t["title"] for t in res.json()]
    assert "Shared task" in titles


@pytest.mark.asyncio
async def test_team_tasks_exclude_trashed(client, test_user):
    """A task shared to a team but soft-deleted by the owner must disappear from
    the team's shared task list - the trash hides it from every surface, team
    views included (and restore brings it back)."""
    team = (await client.post("/api/teams/", json={"name": "Epsilon"})).json()
    task = (await client.post("/api/tasks/", json={"title": "Team zombie", "status": "todo"})).json()
    assert (await client.post(f"/api/teams/{team['id']}/share-task", json={"task_id": task["id"]})).status_code == 200

    assert (await client.delete(f"/api/tasks/{task['id']}")).status_code == 200

    res = await client.get(f"/api/teams/{team['id']}/tasks")
    assert res.status_code == 200
    assert all(t["title"] != "Team zombie" for t in res.json())

    # Undo brings it back to the team surface too.
    assert (await client.post(f"/api/tasks/{task['id']}/restore", json={})).status_code == 200
    res = await client.get(f"/api/teams/{team['id']}/tasks")
    assert any(t["title"] == "Team zombie" for t in res.json())


@pytest.mark.asyncio
async def test_notes_crud(client):
    res = await client.post(
        "/api/notes/",
        json={"id": "sticky_test1", "title": "Hello", "content": "World", "color": "#fbbf24"},
    )
    assert res.status_code == 200
    assert res.json()["title"] == "Hello"

    res = await client.patch("/api/notes/sticky_test1", json={"content": "Updated"})
    assert res.status_code == 200
    assert res.json()["content"] == "Updated"

    res = await client.get("/api/notes/")
    assert res.status_code == 200
    assert len(res.json()) == 1

    res = await client.delete("/api/notes/sticky_test1")
    assert res.status_code == 200
    assert (await client.get("/api/notes/")).json() == []


@pytest.mark.asyncio
async def test_share_only_own_task(client, test_user):
    team = (await client.post("/api/teams/", json={"name": "Delta"})).json()
    # Share a bogus task id -> 404
    res = await client.post(f"/api/teams/{team['id']}/share-task", json={"task_id": "00000000-0000-0000-0000-000000000000"})
    assert res.status_code == 404
