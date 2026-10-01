import pytest
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_section import BoardSection
from app.models.task import Task
from app.models.user import User
from app.models.user_preference import UserPreference
from app.routers.board_sections import SEED_FLAG_PREFIX, _claim_seed


@pytest.mark.asyncio
async def test_lazy_seeds_default_kanban_sections(client: AsyncClient):
    resp = await client.get("/api/board-sections/?kind=kanban")
    assert resp.status_code == 200
    sections = resp.json()
    assert len(sections) == 4
    assert {s["status"] for s in sections} == {"backlog", "todo", "in_progress", "done"}
    assert [s["title"] for s in sections] == ["Backlog", "To Do", "In Progress", "Done"]
    assert [s["color"] for s in sections] == ["#9E9E9E", "#4FC3F7", "#FFA726", "#66BB6A"]


@pytest.mark.asyncio
async def test_board_kind_starts_empty(client: AsyncClient):
    resp = await client.get("/api/board-sections/?kind=board")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_defaults_seeded_only_once(client: AsyncClient):
    first = (await client.get("/api/board-sections/?kind=kanban")).json()
    second = (await client.get("/api/board-sections/?kind=kanban")).json()
    assert len(first) == 4
    assert len(second) == 4


@pytest.mark.asyncio
async def test_timeline_starts_empty_and_never_seeds(client: AsyncClient):
    # Timeline sections are per-list and are never auto-created: a brand-new
    # scope must not show phantom "Section 1/2/3" rows.
    assert (await client.get("/api/board-sections/?kind=timeline")).json() == []
    assert (await client.get("/api/board-sections/?kind=timeline&list_id=")).json() == []
    assert (await client.get("/api/board-sections/?kind=timeline")).json() == []


@pytest.mark.asyncio
async def test_deleted_kanban_sections_stay_deleted(client: AsyncClient):
    seeded = (await client.get("/api/board-sections/?kind=kanban")).json()
    assert len(seeded) == 4
    for section in seeded:
        assert (await client.delete(f"/api/board-sections/{section['id']}")).status_code == 200
    assert (await client.get("/api/board-sections/?kind=kanban")).json() == []


@pytest.mark.asyncio
async def test_seed_claim_is_atomic(client: AsyncClient, test_user, db_session: AsyncSession):
    """F1: the seed marker claim must win exactly once and never raise.

    Two concurrent first loads used to both pass the SELECT and then have the
    loser violate ``uq_user_preferences_user_key`` at flush (a 500). The claim
    is now a SAVEPOINT-guarded insert: the second attempt returns False instead
    of an IntegrityError leaking out of the request.
    """
    assert await _claim_seed(db_session, test_user.id, "timeline") is True
    assert await _claim_seed(db_session, test_user.id, "timeline") is False
    await db_session.commit()
    marker = (
        await db_session.execute(
            select(UserPreference).where(
                UserPreference.user_id == test_user.id,
                UserPreference.key == f"{SEED_FLAG_PREFIX}timeline",
            )
        )
    ).scalar_one()
    assert marker is not None


@pytest.mark.asyncio
async def test_marker_without_sections_stays_empty(client: AsyncClient, test_user, db_session: AsyncSession):
    """A claimed seed with no rows left is the user's delete-all choice."""
    db_session.add(UserPreference(user_id=test_user.id, key=f"{SEED_FLAG_PREFIX}timeline", value=True))
    await db_session.commit()
    assert (await client.get("/api/board-sections/?kind=timeline")).json() == []


@pytest.mark.asyncio
async def test_timeline_sections_are_scoped_per_list(client: AsyncClient):
    list_a = (await client.post("/api/lists/", json={"name": "List A"})).json()
    list_b = (await client.post("/api/lists/", json={"name": "List B"})).json()

    created = (
        await client.post(
            "/api/board-sections/",
            json={"kind": "timeline", "title": "List A work", "list_id": list_a["id"]},
        )
    ).json()
    assert created["list_id"] == list_a["id"]

    a_sections = (
        await client.get(f"/api/board-sections/?kind=timeline&list_id={list_a['id']}")
    ).json()
    assert [s["id"] for s in a_sections] == [created["id"]]

    # A different list sees none of List A's sections.
    b_sections = (
        await client.get(f"/api/board-sections/?kind=timeline&list_id={list_b['id']}")
    ).json()
    assert b_sections == []

    # The no-list scope is separate again.
    assert (await client.get("/api/board-sections/?kind=timeline&list_id=")).json() == []


@pytest.mark.asyncio
async def test_invalid_kind_rejected(client: AsyncClient):
    assert (await client.get("/api/board-sections/?kind=nope")).status_code == 422


@pytest.mark.asyncio
async def test_create_free_section(client: AsyncClient):
    resp = await client.post("/api/board-sections/", json={
        "kind": "board", "title": "Ideas", "color": "#ff0000",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Ideas"
    assert data["color"] == "#ff0000"
    assert data["status"] is None
    assert data["position"] == 0


@pytest.mark.asyncio
async def test_status_section_upserts(client: AsyncClient):
    await client.get("/api/board-sections/?kind=kanban")  # seed defaults
    resp = await client.post("/api/board-sections/", json={
        "kind": "kanban", "title": "WIP", "color": "#123456", "status": "in_progress",
    })
    assert resp.status_code == 200
    assert resp.json()["title"] == "WIP"
    assert resp.json()["color"] == "#123456"
    sections = (await client.get("/api/board-sections/?kind=kanban")).json()
    assert len(sections) == 4  # upserted, not inserted
    wip = next(s for s in sections if s["status"] == "in_progress")
    assert wip["title"] == "WIP"


@pytest.mark.asyncio
async def test_invalid_status_rejected(client: AsyncClient):
    resp = await client.post("/api/board-sections/", json={
        "kind": "kanban", "title": "X", "status": "bogus",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_section(client: AsyncClient):
    created = (await client.post("/api/board-sections/", json={"kind": "board", "title": "A", "color": "#111111"})).json()
    resp = await client.patch(
        f"/api/board-sections/{created['id']}",
        json={"title": "B", "color": "#222222", "position": 5},
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "B"
    assert resp.json()["color"] == "#222222"
    assert resp.json()["position"] == 5
    assert resp.json()["status"] is None


@pytest.mark.asyncio
async def test_patch_unknown_section_404(client: AsyncClient):
    resp = await client.patch("/api/board-sections/00000000-0000-0000-0000-000000000000", json={"title": "Ghost"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_section_clears_membership(client: AsyncClient, db_session: AsyncSession):
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "Drop"})).json()
    task = (await client.post("/api/tasks/", json={"title": "Pinned"})).json()
    moved = await client.post(
        "/api/tasks/board-move",
        json={"task_id": task["id"], "section_id": section["id"], "index": 0},
    )
    assert moved.status_code == 200
    assert moved.json()["board_section_id"] == section["id"]

    assert (await client.delete(f"/api/board-sections/{section['id']}")).status_code == 200

    fetched = (
        await db_session.execute(select(Task).where(Task.id == task["id"]))
    ).scalar_one()
    assert fetched.board_section_id is None


@pytest.mark.asyncio
async def test_cross_user_isolation(client: AsyncClient, db_session: AsyncSession):
    other = User(id=uuid4(), email="section-other@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_section = BoardSection(user_id=other.id, kind="board", title="Secret", color="#000000", position=0)
    db_session.add(other_section)
    await db_session.commit()

    resp = await client.get("/api/board-sections/?kind=board")
    assert all(s["id"] != str(other_section.id) for s in resp.json())

    assert (await client.patch(f"/api/board-sections/{other_section.id}", json={"title": "hacked"})).status_code == 404
    assert (await client.delete(f"/api/board-sections/{other_section.id}")).status_code == 404


@pytest.mark.asyncio
async def test_position_ordering(client: AsyncClient):
    for i, title in enumerate(["First", "Second", "Third"]):
        resp = await client.post("/api/board-sections/", json={"kind": "board", "title": title})
        assert resp.status_code == 200
        assert resp.json()["position"] == i
    resp = await client.get("/api/board-sections/?kind=board")
    assert [s["title"] for s in resp.json()] == ["First", "Second", "Third"]
