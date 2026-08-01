from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task
from app.services import subtask_service
from app.services.ai_service import execute_tool_calls
from app.utils.priority import normalize_priority
import json


@pytest.mark.asyncio
async def test_normalize_priority():
    assert normalize_priority(None) == 2
    assert normalize_priority(0) == 2
    assert normalize_priority(1) == 1
    assert normalize_priority(2) == 2
    assert normalize_priority(3) == 3
    assert normalize_priority(4) == 3
    assert normalize_priority(5) == 3


@pytest.mark.asyncio
async def test_convert_description_to_subtasks(db_session: AsyncSession, ai_user):
    parent = Task(
        user_id=ai_user,
        title="Plan launch",
        description="- Research market\n* Define goals\n- Build roadmap",
        priority=1,
    )
    db_session.add(parent)
    await db_session.flush()

    created = await subtask_service.convert_description_to_subtasks(db_session, parent)
    assert len(created) == 3
    assert parent.description is None
    titles = sorted(t.title for t in created)
    assert titles == ["Build roadmap", "Define goals", "Research market"]
    # Each child inherits the parent's priority.
    assert all(t.priority == 1 for t in created)
    # Children are ordered by sort_order.
    orders = [t.sort_order for t in created]
    assert orders == sorted(orders)


@pytest.mark.asyncio
async def test_convert_subtasks_to_description_round_trip(db_session: AsyncSession, ai_user):
    parent = Task(user_id=ai_user, title="Write report", description="Original", priority=2)
    db_session.add(parent)
    await db_session.flush()

    for i, title in enumerate(["Plan outline", "Draft sections", "Proofread"]):
        child = Task(
            user_id=ai_user, parent_task_id=parent.id, title=title,
            status="todo", sort_order=i,
        )
        db_session.add(child)
    await db_session.flush()

    description = await subtask_service.convert_subtasks_to_description(db_session, parent)
    assert description == "- Plan outline\n- Draft sections\n- Proofread"

    from sqlalchemy import select
    leftovers = (await db_session.execute(select(Task).where(Task.parent_task_id == parent.id))).scalars().all()
    assert leftovers == []


@pytest.mark.asyncio
async def test_reorder_subtasks(db_session: AsyncSession, ai_user):
    parent = Task(user_id=ai_user, title="Parent", priority=2)
    db_session.add(parent)
    await db_session.flush()

    ids = []
    for title in ["a", "b", "c"]:
        child = Task(user_id=ai_user, parent_task_id=parent.id, title=title, status="todo")
        db_session.add(child)
        await db_session.flush()
        ids.append(str(child.id))

    await subtask_service.reorder_subtasks(db_session, parent, [ids[2], ids[0], ids[1]])

    from sqlalchemy import select
    children = (await db_session.execute(
        select(Task).where(Task.parent_task_id == parent.id).order_by(Task.sort_order)
    )).scalars().all()
    assert [c.title for c in children] == ["c", "a", "b"]
    assert [c.sort_order for c in children] == [0, 1, 2]


@pytest.mark.asyncio
async def test_ai_tools_subtask_crud(db_session: AsyncSession, ai_user):
    """The AI subtask tools create, read, reorder and convert on a parent task."""
    parent = Task(user_id=ai_user, title="Launch", priority=1)
    db_session.add(parent)
    await db_session.flush()
    parent_id = str(parent.id)

    # get_subtasks on empty parent
    res = await execute_tool_calls(
        [{"id": "g1", "function": {"name": "get_subtasks", "arguments": json.dumps({"task_id": parent_id})}}],
        str(ai_user), db_session,
    )
    assert json.loads(res[0]["content"])["count"] == 0

    # create_subtask twice
    for n, t in [("c1", "sub one"), ("c2", "sub two")]:
        r = await execute_tool_calls(
            [{"id": n, "function": {"name": "create_subtask", "arguments": json.dumps({"task_id": parent_id, "title": t})}}],
            str(ai_user), db_session,
        )
        assert json.loads(r[0]["content"])["created"] is True

    # convert description to subtasks
    parent.description = "- step one\n- step two"
    await db_session.flush()
    r = await execute_tool_calls(
        [{"id": "d2s", "function": {"name": "convert_description_to_subtasks", "arguments": json.dumps({"task_id": parent_id})}}],
        str(ai_user), db_session,
    )
    assert json.loads(r[0]["content"])["subtask_count"] == 2

    # convert subtasks to description
    r = await execute_tool_calls(
        [{"id": "s2d", "function": {"name": "convert_subtasks_to_description", "arguments": json.dumps({"task_id": parent_id})}}],
        str(ai_user), db_session,
    )
    desc = json.loads(r[0]["content"])["description"]
    assert "step one" in desc and "step two" in desc

    # delete_subtask with a bad id returns an error, not a crash
    r = await execute_tool_calls(
        [{"id": "del", "function": {"name": "delete_subtask", "arguments": json.dumps({"task_id": parent_id, "subtask_id": "00000000-0000-0000-0000-000000000000"})}}],
        str(ai_user), db_session,
    )
    assert "error" in json.loads(r[0]["content"])
