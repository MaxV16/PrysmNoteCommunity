import json
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.ai_service import execute_tool_calls, build_messages, TOOL_DEFINITIONS


@pytest.mark.asyncio
async def test_build_messages(db_session: AsyncSession):
    messages = build_messages([{"role": "user", "content": "hi"}], "create a task")
    assert len(messages) == 3
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "user"
    assert messages[1]["content"] == "hi"


@pytest.mark.asyncio
async def test_tool_definitions_have_all_tools():
    tool_names = {t["function"]["name"] for t in TOOL_DEFINITIONS}
    expected = {
        "search_tasks", "create_task", "update_task", "delete_task",
        "get_task_details", "link_tasks", "check_calendar",
        "suggest_subtasks", "detect_conflicts",
    }
    assert tool_names == expected, f"Missing tools: {expected - tool_names}"


@pytest.mark.asyncio
async def test_build_messages_with_context(db_session: AsyncSession):
    context = {
        "focused_task": {"title": "Fix bug", "description": "Critical bug in login", "project_name": "Dev"},
        "view_filter": "today",
        "calendar_density": [{"date": "2025-01-15", "count": 6}],
    }
    messages = build_messages([], "what should I do?", context)
    assert len(messages) == 2
    system = messages[0]["content"]
    assert "Fix bug" in system
    assert "today" in system
    assert "overcrowded" in system


@pytest.mark.asyncio
async def test_build_messages_limits_chat_history(db_session: AsyncSession):
    long_history = [{"role": "user", "content": f"msg {i}"} for i in range(50)]
    messages = build_messages(long_history, "final")
    # MAX_CHAT_HISTORY is 20, plus system + new user = 22
    assert len(messages) == 22


@pytest.mark.asyncio
async def test_execute_create_task(db_session: AsyncSession):
    user_id = uuid4()
    tool_calls = [{
        "id": "call_1",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "AI Created Task"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert content["created"] is True
    assert content["task"]["title"] == "AI Created Task"


@pytest.mark.asyncio
async def test_execute_create_task_in_project(db_session: AsyncSession):
    from app.models.project import Project
    from uuid import UUID
    user_id = uuid4()
    project = Project(user_id=user_id, name="AI Project")
    db_session.add(project)
    await db_session.flush()

    tool_calls = [{
        "id": "call_proj",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "Project Task", "project": "AI Project"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert content["created"] is True


@pytest.mark.asyncio
async def test_execute_search_tasks(db_session: AsyncSession):
    user_id = uuid4()
    tool_calls = [{
        "id": "call_2",
        "function": {
            "name": "search_tasks",
            "arguments": json.dumps({"query": "test"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert "found" in content
    assert "tasks" in content


@pytest.mark.asyncio
async def test_execute_update_task(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="Original")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_upd",
        "function": {
            "name": "update_task",
            "arguments": json.dumps({"task_id": str(task.id), "fields": {"title": "Updated"}}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert content["updated"] is True


@pytest.mark.asyncio
async def test_execute_update_task_not_found(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_notfound",
        "function": {
            "name": "update_task",
            "arguments": json.dumps({"task_id": str(uuid4()), "fields": {"title": "Nope"}}),
        },
    }]
    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_delete_task(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="Delete Me")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_del",
        "function": {
            "name": "delete_task",
            "arguments": json.dumps({"task_id": str(task.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["deleted"] is True


@pytest.mark.asyncio
async def test_execute_delete_task_not_found(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_del_nf",
        "function": {
            "name": "delete_task",
            "arguments": json.dumps({"task_id": str(uuid4())}),
        },
    }]
    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_get_task_details(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="Details Please")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_details",
        "function": {
            "name": "get_task_details",
            "arguments": json.dumps({"task_id": str(task.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["title"] == "Details Please"


@pytest.mark.asyncio
async def test_execute_link_tasks(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    t1 = Task(user_id=user_id, title="Source")
    t2 = Task(user_id=user_id, title="Target")
    db_session.add_all([t1, t2])
    await db_session.flush()

    tool_calls = [{
        "id": "call_link",
        "function": {
            "name": "link_tasks",
            "arguments": json.dumps({
                "source_id": str(t1.id),
                "target_id": str(t2.id),
                "link_type": "blocks",
            }),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True


@pytest.mark.asyncio
async def test_execute_check_calendar(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="Scheduled", start_date="2025-06-01", due_date="2025-06-01")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_cal",
        "function": {
            "name": "check_calendar",
            "arguments": json.dumps({"date_from": "2025-05-01", "date_to": "2025-07-01"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "density" in content
    assert len(content["density"]) >= 1


@pytest.mark.asyncio
async def test_execute_detect_conflicts(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    t1 = Task(user_id=user_id, title="Main", start_date="2025-06-15", due_date="2025-06-20")
    t2 = Task(user_id=user_id, title="Overlap", start_date="2025-06-18", due_date="2025-06-22")
    db_session.add_all([t1, t2])
    await db_session.flush()

    tool_calls = [{
        "id": "call_conflict",
        "function": {
            "name": "detect_conflicts",
            "arguments": json.dumps({"task_id": str(t1.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "conflicts" in content
    assert len(content["conflicts"]) >= 1


@pytest.mark.asyncio
async def test_execute_detect_conflicts_no_dates(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="No Dates")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_nodate",
        "function": {
            "name": "detect_conflicts",
            "arguments": json.dumps({"task_id": str(task.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_suggest_subtasks(db_session: AsyncSession):
    from app.models.task import Task
    user_id = uuid4()
    task = Task(user_id=user_id, title="Plan Event")
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_suggest",
        "function": {
            "name": "suggest_subtasks",
            "arguments": json.dumps({"task_id": str(task.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "suggestions" in content
    assert len(content["suggestions"]) > 0


@pytest.mark.asyncio
async def test_execute_suggest_subtasks_no_task(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_suggest_nf",
        "function": {
            "name": "suggest_subtasks",
            "arguments": json.dumps({"task_id": str(uuid4())}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_invalid_tool(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_3",
        "function": {
            "name": "nonexistent_tool",
            "arguments": "{}",
        },
    }]

    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_invalid_tool_args(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_bad",
        "function": {
            "name": "create_task",
            "arguments": "not valid json",
        },
    }]

    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    assert len(results) == 1
    assert "Invalid" in results[0]["content"]
