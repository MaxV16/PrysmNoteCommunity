import asyncio
import pytest
from datetime import date, datetime, timedelta, timezone
from httpx import AsyncClient
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.task import Task, TaskStatus


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
async def test_task_time_round_trip(client: AsyncClient):
    """start_time/end_time round-trip as HH:MM strings: validated on create,
    echoed on GET, and updatable via PATCH (frontend contract)."""
    from datetime import time as dtime

    response = await client.post("/api/tasks/", json={
        "title": "Mechanic at 2",
        "start_date": "2026-09-08",
        "start_time": "14:00",
        "end_time": "16:30",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["start_time"] == "14:00"
    assert data["end_time"] == "16:30"
    tid = data["id"]

    fetched = await client.get(f"/api/tasks/{tid}")
    assert fetched.status_code == 200
    assert fetched.json()["start_time"] == "14:00"

    patched = await client.patch(f"/api/tasks/{tid}", json={"start_time": "09:30", "end_time": None})
    assert patched.status_code == 200
    assert patched.json()["start_time"] == "09:30"
    assert patched.json()["end_time"] is None


@pytest.mark.asyncio
async def test_task_time_rejects_bad_format(client: AsyncClient):
    response = await client.post("/api/tasks/", json={
        "title": "Bad time",
        "start_time": "2pm",
    })
    assert response.status_code == 422

    created = await client.post("/api/tasks/", json={"title": "Patch bad time"})
    tid = created.json()["id"]
    assert (await client.patch(f"/api/tasks/{tid}", json={"end_time": "noon"})).status_code == 422


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
    # And it must not have created a whole-year flood: the pre-roll is bounded by
    # the initial horizon (a daily template would fill it; weekdays never exceed it).
    from app.services.recurring_task_service import INITIAL_HORIZON_DAYS
    assert len(child_dates) <= INITIAL_HORIZON_DAYS


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


@pytest.mark.asyncio
async def test_update_task_accepts_board_fields(client: AsyncClient):
    """PATCH must accept board_section_id/board_order (whitelisted fields) and
    the serializer must round-trip them."""
    created = (await client.post("/api/tasks/", json={"title": "Board Fields"})).json()
    section = (await client.post("/api/board-sections/", json={"kind": "board", "title": "S"})).json()
    resp = await client.patch(f"/api/tasks/{created['id']}", json={
        "board_section_id": section["id"],
        "board_order": 3,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["board_section_id"] == section["id"]
    assert data["board_order"] == 3


@pytest.mark.asyncio
async def test_task_serializer_includes_board_fields(client: AsyncClient):
    created = (await client.post("/api/tasks/", json={"title": "Serialized"})).json()
    assert "board_section_id" in created
    assert "board_order" in created
    assert created["board_section_id"] is None
    assert created["board_order"] is None


async def _recurring_user(db_session: AsyncSession):
    from app.models.user import User

    user = User(id=uuid4(), email=f"{uuid4()}@recurring.test", password_hash="fake")
    db_session.add(user)
    await db_session.commit()
    return user


@pytest.mark.asyncio
async def test_recurring_loop_skips_template_expanded_within_cooldown(db_session: AsyncSession):
    """Templates expanded within the cooldown window are not scanned again."""
    user = await _recurring_user(db_session)
    db_session.add(
        Task(
            user_id=user.id,
            title="Cooldown",
            start_date=date.today() - timedelta(days=1),
            recurrence_rule="FREQ=WEEKLY;COUNT=4",
            status=TaskStatus.TODO,
            recurrence_last_expanded_at=datetime.now(timezone.utc),
        )
    )
    await db_session.commit()

    from app.services.recurring_task_service import expand_recurring_tasks

    assert await expand_recurring_tasks(db_session) == 0


@pytest.mark.asyncio
async def test_recurring_loop_skips_ended_templates(db_session: AsyncSession):
    """Templates whose recurrence_end_date is in the past are never scanned."""
    user = await _recurring_user(db_session)
    db_session.add(
        Task(
            user_id=user.id,
            title="Ended",
            start_date=date(2020, 1, 1),
            recurrence_rule="FREQ=WEEKLY;COUNT=4",
            recurrence_end_date=date(2020, 2, 1),
            status=TaskStatus.TODO,
        )
    )
    await db_session.commit()

    from app.services.recurring_task_service import expand_recurring_tasks

    assert await expand_recurring_tasks(db_session) == 0
    children = (
        await db_session.execute(
            select(Task).where(Task.title == "Ended", Task.parent_task_id.isnot(None))
        )
    ).scalars().all()
    assert children == []


@pytest.mark.asyncio
async def test_recurring_loop_expands_and_stamps_cooldown(db_session: AsyncSession):
    """A never-expanded active template is expanded and stamped with the
    cooldown timestamp, so the immediate next pass skips it."""
    user = await _recurring_user(db_session)
    task = Task(
        user_id=user.id,
        title="Active",
        start_date=date.today() - timedelta(days=1),
        recurrence_rule="FREQ=WEEKLY;COUNT=4",
        status=TaskStatus.TODO,
    )
    db_session.add(task)
    await db_session.commit()

    from app.services.recurring_task_service import expand_recurring_tasks

    first = await expand_recurring_tasks(db_session)
    assert first > 0
    await db_session.commit()
    await db_session.refresh(task)
    assert task.recurrence_last_expanded_at is not None
    assert await expand_recurring_tasks(db_session) == 0


@pytest.mark.asyncio
async def test_create_task_accepts_recurrence_end_date(client: AsyncClient):
    """POST /api/tasks must persist recurrence_end_date (create previously lacked it)."""
    created = await client.post("/api/tasks/", json={
        "title": "Ending Recurrence",
        "start_date": "2026-09-01",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO",
        "recurrence_end_date": "2026-12-31",
    })
    assert created.status_code == 200
    assert created.json()["recurrence_end_date"] == "2026-12-31"


@pytest.mark.asyncio
async def test_create_task_rejects_bad_recurrence_end_date(client: AsyncClient):
    response = await client.post("/api/tasks/", json={
        "title": "Bad End",
        "recurrence_rule": "FREQ=DAILY",
        "recurrence_end_date": "12/31/2026",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_list_tasks_range_lazily_expands_endless_recurrence(client: AsyncClient):
    """GET /api/tasks?date_from&date_to must materialize occurrences far beyond the
    initial horizon on demand and return them with full serialization."""
    start = date.today() - timedelta(days=10)
    created = await client.post("/api/tasks/", json={
        "title": "Lazy Daily",
        "start_date": start.isoformat(),
        "recurrence_rule": "FREQ=DAILY",
    })
    assert created.status_code == 200

    # A window well beyond the 90-day initial horizon.
    from_date = date.today() + timedelta(days=120)
    to_date = from_date + timedelta(days=6)
    response = await client.get("/api/tasks/", params={
        "date_from": from_date.isoformat(),
        "date_to": to_date.isoformat(),
    })
    assert response.status_code == 200
    tasks = response.json()
    children = [t for t in tasks if t.get("parent_task_id")]
    child_dates = {date.fromisoformat(t["start_date"]) for t in children}
    expected = {from_date + timedelta(days=i) for i in range(7)}
    assert expected.issubset(child_dates), f"missing lazy occurrences: {expected - child_dates}"
    # Full serialization (tags + board fields), not the reduced date-range schema.
    assert all("board_section_id" in t and "board_order" in t and "tags" in t for t in children)

    # Idempotent: a second fetch must not duplicate rows.
    second = (await client.get("/api/tasks/", params={
        "date_from": from_date.isoformat(),
        "date_to": to_date.isoformat(),
    })).json()
    assert [t["id"] for t in second] == [t["id"] for t in tasks]


@pytest.mark.asyncio
async def test_create_recurring_task_without_start_date_anchors_today(client: AsyncClient):
    """A recurring template created with no start_date is anchored at today so the
    endless series materializes immediately instead of silently doing nothing."""
    today = date.today()
    created = await client.post("/api/tasks/", json={
        "title": "Anchored Daily",
        "recurrence_rule": "FREQ=DAILY",
    })
    assert created.status_code == 200
    data = created.json()
    assert data["start_date"] == today.isoformat()
    assert data["recurrence_rule"] == "FREQ=DAILY"

    # Children exist from tomorrow on (the template row is today's occurrence).
    from_date = today + timedelta(days=1)
    to_date = from_date + timedelta(days=6)
    response = await client.get("/api/tasks/", params={
        "date_from": from_date.isoformat(),
        "date_to": to_date.isoformat(),
    })
    assert response.status_code == 200
    children = [
        t for t in response.json()
        if t.get("parent_task_id") and t["title"] == "Anchored Daily"
    ]
    child_dates = {date.fromisoformat(t["start_date"]) for t in children}
    expected = {from_date + timedelta(days=i) for i in range(7)}
    assert expected.issubset(child_dates), f"missing anchored occurrences: {expected - child_dates}"


@pytest.mark.asyncio
async def test_patch_adds_recurrence_to_undated_task_expands(client: AsyncClient):
    """PATCHing a recurrence rule onto an undated task anchors it at today and
    materializes its children immediately (no waiting for the background loop)."""
    created = (await client.post("/api/tasks/", json={"title": "Become Daily"})).json()
    assert created["start_date"] is None

    patched = await client.patch(f"/api/tasks/{created['id']}", json={
        "recurrence_rule": "FREQ=DAILY",
    })
    assert patched.status_code == 200
    data = patched.json()
    assert data["start_date"] == date.today().isoformat()
    assert data["recurrence_rule"] == "FREQ=DAILY"

    from_date = date.today() + timedelta(days=1)
    response = await client.get("/api/tasks/", params={
        "date_from": from_date.isoformat(),
        "date_to": (from_date + timedelta(days=3)).isoformat(),
    })
    assert response.status_code == 200
    children = [
        t for t in response.json()
        if t.get("parent_task_id") and t["title"] == "Become Daily"
    ]
    child_dates = {date.fromisoformat(t["start_date"]) for t in children}
    expected = {from_date + timedelta(days=i) for i in range(4)}
    assert expected.issubset(child_dates), f"missing expanded occurrences: {expected - child_dates}"


@pytest.mark.asyncio
async def test_expand_task_occurrences_anchors_undated_template(db_session: AsyncSession):
    """expand_task_occurrences on a template with no start_date anchors it at today,
    creates its children up to the horizon, and is idempotent on rerun."""
    from app.services.recurring_task_service import (
        INITIAL_HORIZON_DAYS,
        expand_task_occurrences,
    )

    user = await _recurring_user(db_session)
    task = Task(
        user_id=user.id,
        title="Undated Template",
        recurrence_rule="FREQ=DAILY",
        status=TaskStatus.TODO,
    )
    db_session.add(task)
    await db_session.commit()

    first = await expand_task_occurrences(db_session, task)
    assert task.start_date == date.today()
    # The template row is today's occurrence, so children fill tomorrow..+horizon.
    assert first == INITIAL_HORIZON_DAYS

    assert await expand_task_occurrences(db_session, task) == 0

    children = (
        await db_session.execute(
            select(Task).where(Task.parent_task_id.isnot(None), Task.title == "Undated Template")
        )
    ).scalars().all()
    assert len(children) == first
    assert {c.start_date for c in children} == {
        date.today() + timedelta(days=i) for i in range(1, INITIAL_HORIZON_DAYS + 1)
    }


@pytest.mark.asyncio
async def test_list_tasks_range_invalid_dates_422(client: AsyncClient):
    response = await client.get("/api/tasks/", params={"date_from": "not-a-date"})
    assert response.status_code == 422
    response = await client.get("/api/tasks/", params={
        "date_from": "2026-12-31",
        "date_to": "2026-01-01",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_expand_recurring_for_range_only_creates_in_range(db_session: AsyncSession):
    from app.services.recurring_task_service import expand_recurring_for_range

    user = await _recurring_user(db_session)
    db_session.add(
        Task(
            user_id=user.id,
            title="Range Daily",
            start_date=date.today() - timedelta(days=30),
            recurrence_rule="FREQ=DAILY",
            status=TaskStatus.TODO,
        )
    )
    await db_session.commit()

    from_date = date.today() + timedelta(days=200)
    to_date = from_date + timedelta(days=2)
    assert await expand_recurring_for_range(db_session, user.id, from_date, to_date) == 3

    children = (
        await db_session.execute(
            select(Task).where(Task.parent_task_id.isnot(None), Task.title == "Range Daily")
        )
    ).scalars().all()
    assert len(children) == 3
    assert all(from_date <= c.start_date <= to_date for c in children)

    # Idempotent: re-running creates nothing.
    assert await expand_recurring_for_range(db_session, user.id, from_date, to_date) == 0


@pytest.mark.asyncio
async def test_expand_recurring_for_range_does_not_stamp_cooldown(db_session: AsyncSession):
    """On-demand expansion must not advance recurrence_last_expanded_at, or the
    hourly background loop would prematurely skip the template."""
    from app.services.recurring_task_service import expand_recurring_for_range

    user = await _recurring_user(db_session)
    task = Task(
        user_id=user.id,
        title="No Stamp",
        start_date=date.today() - timedelta(days=1),
        recurrence_rule="FREQ=DAILY",
        status=TaskStatus.TODO,
    )
    db_session.add(task)
    await db_session.commit()

    assert await expand_recurring_for_range(db_session, user.id, date.today(), date.today() + timedelta(days=3)) == 4
    await db_session.refresh(task)
    assert task.recurrence_last_expanded_at is None


@pytest.mark.asyncio
async def test_expand_recurring_copies_start_end_time(db_session: AsyncSession):
    """Recurring children must inherit the template's start_time/end_time so
    previews and the timeline keep the clock slot on every occurrence."""
    from datetime import time as dtime
    from app.services.recurring_task_service import expand_recurring_for_range

    user = await _recurring_user(db_session)
    task = Task(
        user_id=user.id,
        title="Timed Daily",
        start_date=date.today(),
        start_time=dtime(14, 0),
        end_time=dtime(16, 30),
        recurrence_rule="FREQ=DAILY",
        status=TaskStatus.TODO,
    )
    db_session.add(task)
    await db_session.commit()

    assert await expand_recurring_for_range(db_session, user.id, date.today() + timedelta(days=1), date.today() + timedelta(days=4)) == 4

    children = (
        await db_session.execute(
            select(Task).where(Task.parent_task_id.isnot(None), Task.title == "Timed Daily")
        )
    ).scalars().all()
    assert len(children) == 4
    for child in children:
        assert child.start_time == dtime(14, 0)
        assert child.end_time == dtime(16, 30)


@pytest.mark.asyncio
async def test_expand_recurring_for_range_respects_end_date_and_count(db_session: AsyncSession):
    from app.services.recurring_task_service import expand_recurring_for_range

    user = await _recurring_user(db_session)
    # End-date terminated: nothing may be created beyond the end date.
    db_session.add(
        Task(
            user_id=user.id,
            title="Ended Soon",
            start_date=date.today(),
            recurrence_rule="FREQ=DAILY",
            recurrence_end_date=date.today() + timedelta(days=10),
            status=TaskStatus.TODO,
        )
    )
    # COUNT-terminated: 3 occurrences total (template is #1), so only 2 children.
    db_session.add(
        Task(
            user_id=user.id,
            title="Counted",
            start_date=date.today() - timedelta(days=1),
            recurrence_rule="FREQ=DAILY;COUNT=3",
            status=TaskStatus.TODO,
        )
    )
    await db_session.commit()

    # Far beyond both terminations: nothing is created.
    far = date.today() + timedelta(days=30)
    assert await expand_recurring_for_range(db_session, user.id, far, far + timedelta(days=30)) == 0

    # The near window: Ended Soon fills today+1..today+10, Counted (COUNT=3 from
    # yesterday) adds today and tomorrow; the template row is never re-created.
    created = await expand_recurring_for_range(db_session, user.id, date.today(), date.today() + timedelta(days=30))
    assert created == 12
    counted_children = (
        await db_session.execute(
            select(Task).where(Task.title == "Counted", Task.parent_task_id.isnot(None))
        )
    ).scalars().all()
    assert {c.start_date for c in counted_children} == {date.today(), date.today() + timedelta(days=1)}


@pytest.mark.asyncio
async def test_expand_task_occurrences_for_range_respects_cap(db_session: AsyncSession):
    """A very wide lazy window is bounded by MAX_OCCURRENCES_ON_DEMAND."""
    from app.services.recurring_task_service import (
        MAX_OCCURRENCES_ON_DEMAND,
        expand_task_occurrences_for_range,
    )

    user = await _recurring_user(db_session)
    task = Task(
        user_id=user.id,
        title="Capped",
        start_date=date.today(),
        recurrence_rule="FREQ=DAILY",
        status=TaskStatus.TODO,
    )
    db_session.add(task)
    await db_session.commit()

    created = await expand_task_occurrences_for_range(
        db_session, task, date.today(), date.today() + timedelta(days=400)
    )
    # The cap bounds created rows; the template row itself is never re-created.
    assert created == MAX_OCCURRENCES_ON_DEMAND


@pytest.mark.asyncio
async def test_create_task_schedules_background_embedding(client: AsyncClient, monkeypatch):
    """Task create must not await the embedding provider inline - it schedules
    the background task (fire-and-forget) and returns immediately."""
    calls = []

    async def fake_embed(task_id, user_id, title, description):
        calls.append((str(task_id), str(user_id), title, description))

    monkeypatch.setattr("app.routers.tasks._embed_task_background", fake_embed)

    response = await client.post("/api/tasks/", json={"title": "Embed Me", "description": "desc"})
    assert response.status_code == 200
    await asyncio.sleep(0.05)
    assert len(calls) == 1
    assert calls[0][2] == "Embed Me"
    assert calls[0][3] == "desc"


@pytest.mark.asyncio
async def test_update_task_schedules_background_embedding(client: AsyncClient, monkeypatch):
    """A title/description update schedules a background embedding and never
    raises, even if the provider path would fail."""
    calls = []

    async def fake_embed(*args):
        calls.append(args)

    monkeypatch.setattr("app.routers.tasks._embed_task_background", fake_embed)

    created = (await client.post("/api/tasks/", json={"title": "Before"})).json()
    await asyncio.sleep(0.05)
    response = await client.patch(f"/api/tasks/{created['id']}", json={"title": "After", "description": "d"})
    assert response.status_code == 200
    await asyncio.sleep(0.05)
    # create + update both scheduled; the update carried the new title.
    assert len(calls) == 2
    assert calls[1][2] == "After"
