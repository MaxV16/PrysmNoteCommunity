import json
from datetime import date
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.ai_service import execute_tool_calls, build_messages, TOOL_DEFINITIONS


@pytest.mark.asyncio
async def test_build_messages(db_session: AsyncSession):
    from datetime import date
    messages = build_messages([{"role": "user", "content": "hi"}], "create a task")
    assert len(messages) == 3
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "user"
    assert messages[1]["content"] == "hi"
    # The system prompt must surface the current date so the model can resolve
    # relative dates ("next Monday", "tomorrow") without extra tool round-trips.
    assert date.today().isoformat() in messages[0]["content"]


@pytest.mark.asyncio
async def test_tool_definitions_have_all_tools():
    tool_names = {t["function"]["name"] for t in TOOL_DEFINITIONS}
    expected = {
        "search_tasks", "create_task", "update_task", "delete_task",
        "get_task_details", "link_tasks", "check_calendar",
        "suggest_subtasks", "detect_conflicts", "reschedule_task",
        "list_tasks_by_date_range", "suggest_best_time",
        "get_upcoming_deadlines", "batch_create_tasks",
        "get_subtasks", "create_subtask", "update_subtask", "delete_subtask",
        "reorder_subtasks", "convert_description_to_subtasks",
        "convert_subtasks_to_description",
    }
    assert tool_names == expected, f"Missing tools: {expected - tool_names}"


@pytest.mark.asyncio
async def test_build_messages_with_context(db_session: AsyncSession):
    context = {
        "focused_task": {"title": "Fix bug", "description": "Critical bug in login"},
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
    # History is capped to CONTEXT_MAX_MESSAGES (12), plus system + new user = 14
    assert len(messages) == 14


@pytest.mark.asyncio
async def test_execute_create_task(db_session: AsyncSession, ai_user):
    user_id = ai_user
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
async def test_execute_search_tasks(db_session: AsyncSession, ai_user):
    user_id = ai_user
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
async def test_execute_update_task(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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
async def test_execute_delete_task(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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
async def test_execute_get_task_details(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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
async def test_execute_get_task_details_owns_only_own_task(db_session: AsyncSession, ai_user):
    """C4: get_task_details (and the other by-ID tools) must not return another
    user's task — the lookup is user-scoped and replies 'Task not found'."""
    from app.models.task import Task
    from app.models.user import User
    from uuid import uuid4
    other_owner = uuid4()
    db_session.add(User(id=other_owner, email=f"{other_owner}@other.test", password_hash="x", display_name="Other"))
    other_task = Task(user_id=other_owner, title="Someone else's secret")
    db_session.add(other_task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_details_own",
        "function": {
            "name": "get_task_details",
            "arguments": json.dumps({"task_id": str(other_task.id)}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(ai_user), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content, f"cross-user get_task_details must 404-equivalent: {content}"


@pytest.mark.asyncio
async def test_execute_link_tasks(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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
async def test_execute_check_calendar(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
    task = Task(user_id=user_id, title="Scheduled", start_date=date(2025, 6, 1), due_date=date(2025, 6, 1))
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
async def test_execute_detect_conflicts(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
    t1 = Task(user_id=user_id, title="Main", start_date=date(2025, 6, 15), due_date=date(2025, 6, 20))
    t2 = Task(user_id=user_id, title="Overlap", start_date=date(2025, 6, 18), due_date=date(2025, 6, 22))
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
async def test_execute_detect_conflicts_no_dates(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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
async def test_execute_suggest_subtasks(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
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


@pytest.mark.asyncio
async def test_execute_reschedule_task(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
    task = Task(user_id=user_id, title="Move Me", start_date=date(2025, 6, 1), due_date=date(2025, 6, 5))
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_resched",
        "function": {
            "name": "reschedule_task",
            "arguments": json.dumps({
                "task_id": str(task.id),
                "new_start_date": "2025-07-01",
                "new_due_date": "2025-07-05",
                "reason": "Conflict with other task",
            }),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["rescheduled"] is True
    assert content["new_start_date"] == "2025-07-01"
    assert content["new_due_date"] == "2025-07-05"


@pytest.mark.asyncio
async def test_execute_reschedule_task_not_found(db_session: AsyncSession):
    tool_calls = [{
        "id": "call_resched_nf",
        "function": {
            "name": "reschedule_task",
            "arguments": json.dumps({"task_id": str(uuid4())}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(uuid4()), db_session)
    content = json.loads(results[0]["content"])
    assert "error" in content


@pytest.mark.asyncio
async def test_execute_list_tasks_by_date_range(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
    task = Task(user_id=user_id, title="In Range", start_date=date(2025, 6, 10), due_date=date(2025, 6, 15))
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_range",
        "function": {
            "name": "list_tasks_by_date_range",
            "arguments": json.dumps({"date_from": "2025-06-01", "date_to": "2025-06-30"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "count" in content
    assert "tasks" in content
    assert content["count"] >= 1


@pytest.mark.asyncio
async def test_execute_get_upcoming_deadlines(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    from datetime import date
    user_id = ai_user
    due = date(2025, 6, 20)
    task = Task(user_id=user_id, title="Urgent", due_date=due)
    db_session.add(task)
    await db_session.flush()

    tool_calls = [{
        "id": "call_deadline",
        "function": {
            "name": "get_upcoming_deadlines",
            "arguments": json.dumps({"days_ahead": 30}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert "deadlines" in content
    assert "count" in content


@pytest.mark.asyncio
async def test_execute_batch_create_tasks(db_session: AsyncSession, ai_user):
    user_id = ai_user
    tool_calls = [{
        "id": "call_batch",
        "function": {
            "name": "batch_create_tasks",
            "arguments": json.dumps({
                "tasks": [
                    {"title": "Batch Task 1", "priority": 3},
                    {"title": "Batch Task 2", "priority": 5},
                ],
            }),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["created_count"] == 2
    assert len(content["tasks"]) == 2


async def _fake_agent_client(*, key):
    """A minimal fake LLM client emulating an OpenAI-style tool-calling loop."""
    class FakeAgent:
        def __init__(self, api_key: str):
            self.api_key = api_key
            self.calls = 0

        async def chat(self, messages, tools=None):
            self.calls += 1
            # First call: request create_task; second call: no tools -> final text.
            if self.calls == 1:
                return {
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "id": "call_agent_1",
                                "function": {
                                    "name": "create_task",
                                    "arguments": json.dumps({"title": "Scheduled GP Visit", "start_date": "2030-01-05"}),
                                },
                            }],
                        }
                    }]
                }
            return {"choices": [{"message": {"role": "assistant", "content": "Done."}}]}

        async def stream_chat(self, messages, tools=None):
            yield "Done."

        async def embed(self, text):
            return [0.0] * 8

    return FakeAgent(api_key=key)


@pytest.mark.asyncio
async def test_router_agent_loop_creates_task(client, ai_user, monkeypatch):
    """The /api/ai/chat endpoint should run multiple tool rounds and actually
    create the task the user asked for (guards the multi-round agent loop)."""
    from app.services.ai_service import get_llm_client

    async def _fake_get_client(provider, api_key):
        return await _fake_agent_client(key=api_key)

    monkeypatch.setattr("app.routers.ai.get_llm_client", _fake_get_client)
    monkeypatch.setattr("app.routers.ai.get_user_api_key", _dummy_key)

    response = await client.post("/api/ai/chat", json={
        "message": "Schedule GP appointment next Monday at 12pm",
        "provider": "openai",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["content"] == "Done."


async def _dummy_key(session, user, provider):
    return "test-key"


@pytest.mark.asyncio
async def test_execute_tool_calls_accepts_uuid_object_user_id(db_session: AsyncSession, ai_user):
    """The router passes user.id, which SQLAlchemy gives us as a uuid.UUID object
    (NOT a string). execute_tool_calls must normalize it internally; otherwise
    every tool crashes with \"'UUID' object has no attribute 'replace'\"."""
    from uuid import UUID as _UUID
    user_id = _UUID(str(ai_user))

    tool_calls = [{
        "id": "call_uuid",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "UUID Task", "start_date": "2026-08-03"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, user_id, db_session)
    assert len(results) == 1
    content = json.loads(results[0]["content"])
    assert content["created"] is True, f"create_task failed with UUID user_id: {results}"


@pytest.mark.asyncio
async def test_execute_search_accepts_uuid_object_user_id(db_session: AsyncSession, ai_user):
    from uuid import UUID as _UUID
    user_id = _UUID(str(ai_user))

    tool_calls = [{
        "id": "call_uuid_s",
        "function": {
            "name": "search_tasks",
            "arguments": json.dumps({"query": "nonexistent"}),
        },
    }]

    results = await execute_tool_calls(tool_calls, user_id, db_session)
    content = json.loads(results[0]["content"])
    assert "found" in content, f"search_tasks failed with UUID user_id: {results}"


@pytest.mark.asyncio
async def test_execute_create_task_conflict_enrichment(db_session: AsyncSession, ai_user):
    """Creating a dated task that overlaps an existing higher-priority (high,
    tier 1, e.g. medical) task must surface a conflict_warning with outranks_new,
    so the model warns instead of silently double-booking."""
    from app.models.task import Task
    user_id = ai_user
    existing = Task(
        user_id=user_id, title="GP Appointment",
        start_date=date(2026, 8, 3), due_date=date(2026, 8, 3), priority=1,
    )
    db_session.add(existing)
    await db_session.flush()

    tool_calls = [{
        "id": "call_conflict_create",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "Team Meeting", "start_date": "2026-08-03", "priority": 2}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True
    assert content["task"]["title"] == "Team Meeting"
    assert "conflict_warning" in content, f"expected conflict_warning in tool result: {content}"
    warn = content["conflict_warning"]
    assert warn["conflict_count"] >= 1
    assert any(c["title"] == "GP Appointment" and c["outranks_new"] for c in warn["conflicts"])


@pytest.mark.asyncio
async def test_execute_create_task_conflict_enrichment_due_date_only(db_session: AsyncSession, ai_user):
    """An existing task that only has a due_date (no start_date) landing on the
    new task's date must still be flagged as a conflict (regression for a dead
    SQL disjunct that made due-date-only tasks undetectable)."""
    from app.models.task import Task
    user_id = ai_user
    existing = Task(
        user_id=user_id, title="Payment Due",
        due_date=date(2026, 8, 3), priority=2,
    )
    db_session.add(existing)
    await db_session.flush()

    tool_calls = [{
        "id": "call_duedate_conflict",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "Client Call", "start_date": "2026-08-03", "priority": 4}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True
    assert "conflict_warning" in content, f"expected due-date-only conflict warning: {content}"
    warn = content["conflict_warning"]
    assert any(c["title"] == "Payment Due" for c in warn["conflicts"])


@pytest.mark.asyncio
async def test_execute_create_task_no_conflict_on_distinct_day(db_session: AsyncSession, ai_user):
    from app.models.task import Task
    user_id = ai_user
    existing = Task(
        user_id=user_id, title="GP Appointment",
        start_date=date(2026, 8, 3), due_date=date(2026, 8, 3), priority=5,
    )
    db_session.add(existing)
    await db_session.flush()

    tool_calls = [{
        "id": "call_distinct",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "Other Day", "start_date": "2026-08-10", "priority": 3}),
        },
    }]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True
    assert "conflict_warning" not in content


@pytest.mark.asyncio
async def test_build_messages_injects_summary(db_session: AsyncSession):
    messages = build_messages([], "follow up on the task", None, "Created task X on 2026-08-03, priority 5.")
    system = messages[0]["content"]
    assert "CONTEXT SUMMARY" in system
    assert "Created task X on 2026-08-03" in system


@pytest.mark.asyncio
async def test_build_messages_has_title_description_rule(db_session: AsyncSession):
    """WS3: the system prompt must instruct the model to keep titles short and put
    supporting detail (times, vendor, context) into description."""
    from app.services.ai_service import build_messages as _build
    messages = _build([], "Buy engine oil for the mechanic on Tuesday", None, None)
    system = messages[0]["content"]
    assert "TITLE vs DESCRIPTION" in system
    assert "description" in system
    assert "Buy supplies" in system  # the worked example


@pytest.mark.asyncio
async def test_execute_create_task_round_trips_description(db_session: AsyncSession, ai_user):
    """WS3: create_task must pass the description through to the Task model (it
    previously dropped it), so a verbose title+description both persist."""
    from uuid import UUID
    from app.models.task import Task
    from sqlalchemy import select
    user_id = str(ai_user)
    tool_calls = [{
        "id": "call_desc",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({
                "title": "Buy supplies",
                "description": "For mechanic (engine oil and related supplies)",
                "start_date": "2026-08-04",
            }),
        },
    }]
    results = await execute_tool_calls(tool_calls, user_id, db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True

    rows = (await db_session.execute(select(Task).where(Task.user_id == UUID(user_id)))).scalars().all()
    assert len(rows) == 1
    assert rows[0].title == "Buy supplies"
    assert rows[0].description == "For mechanic (engine oil and related supplies)"


@pytest.mark.asyncio
async def test_execute_batch_create_tasks_round_trips_description(db_session: AsyncSession, ai_user):
    from uuid import UUID
    from app.models.task import Task
    from sqlalchemy import select
    user_id = str(ai_user)
    tool_calls = [{
        "id": "call_batch_desc",
        "function": {
            "name": "batch_create_tasks",
            "arguments": json.dumps({
                "tasks": [
                    {"title": "Buy supplies", "description": "Engine oil for the mechanic"},
                ],
            }),
        },
    }]
    await execute_tool_calls(tool_calls, user_id, db_session)
    rows = (await db_session.execute(select(Task).where(Task.user_id == UUID(user_id)))).scalars().all()
    assert len(rows) == 1
    assert rows[0].description == "Engine oil for the mechanic"


@pytest.mark.asyncio
async def test_build_messages_skips_empty_summary(db_session: AsyncSession):
    messages = build_messages([], "hello")
    assert "CONTEXT SUMMARY" not in messages[0]["content"]
    messages2 = build_messages([], "hello", None, "   ")
    assert "CONTEXT SUMMARY" not in messages2[0]["content"]


class _FakeSummaryClient:
    def __init__(self):
        self.summary = "User asked me to create a task titled 'Quarterly Report Reply' due 2031-01-15 priority 2."

    async def chat(self, messages, tools=None, **kwargs):
        return {"choices": [{"message": {"role": "assistant", "content": self.summary}}]}


@pytest.mark.asyncio
async def test_session_summary_persists(db_session: AsyncSession, ai_user):
    """_maybe_update_summary should persist a rolling summary to ai_sessions and
    keep it across calls (agent memory), guarded by a length threshold."""
    from app.models.ai_session import AiSession
    from app.routers.ai import _maybe_update_summary, load_session_summary

    user_id = str(ai_user)
    session_id = str(uuid4())
    client = _FakeSummaryClient()

    # Below threshold → no row.
    await _maybe_update_summary(
        db_session, user_id, session_id, client,
        [{"role": "user", "content": "hi"}], "world", "hello", None,
    )
    row = await load_session_summary(db_session, user_id, session_id)
    assert row is None

    # Enough history → summary persisted.
    long_history = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
    await _maybe_update_summary(
        db_session, user_id, session_id, client,
        long_history, "create Quarterly Report Reply for Jan 15", "done", None,
    )
    await db_session.commit()
    row = await load_session_summary(db_session, user_id, session_id)
    assert row is not None
    assert row.summary is not None
    assert "Quarterly Report Reply" in row.summary


@pytest.mark.asyncio
async def test_session_summary_survives_summarizer_failure(db_session: AsyncSession, ai_user):
    """If summarization fails (bad key/network), the existing truncation behavior
    is preserved and the stored summary is not lost nor does it raise."""
    from app.routers.ai import _maybe_update_summary, load_session_summary, summarize_conversation

    class _FailingClient:
        async def chat(self, messages, tools=None, **kwargs):
            raise RuntimeError("boom")

    user_id = str(ai_user)
    session_id = str(uuid4())
    long_history = [{"role": "user", "content": f"msg {i}"} for i in range(10)]

    # Nothing stored yet, summarizer fails → no crash, no summary.
    summary = await summarize_conversation(_FailingClient(), long_history, None)
    assert summary == ""

    # With an existing summary, a failure keeps the old summary.
    kept = await summarize_conversation(_FailingClient(), long_history, "keep me")
    assert kept == "keep me"


@pytest.mark.asyncio
async def test_chat_stream_emits_single_answer_and_usage(client, ai_user, monkeypatch):
    """WS4 + usage: /api/ai/chat/stream must stream the tool loop's final
    content ONCE (no second model call) and emit an SSE `usage` event so the
    frontend can show token usage."""
    from app.services.ai_service import get_llm_client

    class _StreamAgent:
        attempts = 0

        async def chat(self, messages, tools=None):
            type(self).attempts += 1
            if type(self).attempts == 1:
                return {
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "id": "call_s_1",
                                "function": {"name": "create_task", "arguments": json.dumps({"title": "Streamed Task"})},
                            }],
                        }
                    }]
                }
            return {"choices": [{"message": {"role": "assistant", "content": "Done."}}]}

        async def stream_chat(self, messages, tools=None):
            yield "SHOULD NOT BE CALLED (double model call)"

        async def embed(self, text):
            return [0.0] * 8

    agent = _StreamAgent()

    async def _fake_get_client(provider, api_key):
        return agent

    monkeypatch.setattr("app.routers.ai.get_llm_client", _fake_get_client)
    monkeypatch.setattr("app.routers.ai.get_user_api_key", _dummy_key)

    response = await client.post("/api/ai/chat/stream", json={
        "message": "schedule a task",
        "provider": "openai",
    })
    assert response.status_code == 200, response.text

    events = []
    for line in response.text.splitlines():
        if line.startswith("event: "):
            events.append(line[len("event: "):].strip())

    assert "tool_start" in events
    assert "usage" in events, f"missing usage event: {events}"
    # The fake stream_chat would emit 'SHOULD NOT BE CALLED'; if the double call
    # is gone, the token events must come from _chunk_text("Done.").
    assert "SHOULD NOT BE CALLED" not in response.text
    # Single final answer: exactly one occurrence of 'Done.' (not doubled).
    assert response.text.count("Done.") == 1


@pytest.mark.asyncio
async def test_provider_chat_accepts_temperature_max_tokens_kwargs():
    """Regression: summary/memory/subtask calls pass temperature & max_tokens to
    client.chat(). Provider clients must accept those kwargs instead of raising
    TypeError (which silently disabled summaries + memory extraction)."""
    import inspect
    from app.llm.openai_client import OpenAIClient
    from app.llm.deepseek_client import DeepSeekClient
    from app.llm.gemini_client import GeminiClient

    for cls in (OpenAIClient, DeepSeekClient, GeminiClient):
        params = inspect.signature(cls.chat).parameters
        # Summary/memory/subtask flows call chat(..., temperature=..., max_tokens=...),
        # so each provider must accept **kwargs (VAR_KEYWORD).
        assert any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()), cls.__name__


def test_chunk_text_splits_long_final_answer():
    """WS4: _chunk_text turns an already-computed final answer into a few
    token-like chunks so we can stream it once (no second model call)."""
    from app.routers.ai import _chunk_text
    short = "Done."
    assert _chunk_text(short) == ["Done."]
    text = " ".join(["word"] * 1000)
    chunks = _chunk_text(text, size=400)
    assert len(chunks) > 1
    assert " ".join(chunks).strip() == text.strip()
    assert all(len(c) <= 400 for c in chunks)


@pytest.mark.asyncio
async def test_build_messages_injects_recalled_memory(db_session: AsyncSession):
    """WS6: a matching memory must be injected as a RECALLED MEMORY block."""
    messages = build_messages([], "remind me about the mechanic appointment", None, None, [
        "User has an ITV/mechanic appointment Tue 2026-08-04 at 16:00.",
    ])
    system = messages[0]["content"]
    assert "RECALLED MEMORY" in system
    assert "mechanic appointment" in system


@pytest.mark.asyncio
async def test_build_messages_no_memory_no_block(db_session: AsyncSession):
    messages = build_messages([], "hello", None, None, [])
    assert "RECALLED MEMORY" not in messages[0]["content"]
    messages2 = build_messages([], "hello")
    assert "RECALLED MEMORY" not in messages2[0]["content"]


def test_estimate_tokens_counts_prompt_and_completion():
    """Token-usage visibility: _estimate_tokens returns a positive, roughly
    proportional figure derived from prompt + completion text."""
    from app.routers.ai import _estimate_tokens
    short = _estimate_tokens([{"role": "user", "content": "hi"}], "ok")
    assert short > 0
    long_prompt = _estimate_tokens([{"role": "user", "content": "x" * 2000}], "reply")
    big = _estimate_tokens(
        [{"role": "user", "content": "x" * 2000}],
        "y" * 1000,
    )
    # Bigger prompt => bigger estimate; adding a long completion increases it.
    assert big > long_prompt
    # A tool call in the message chain is counted too.
    with_tool = _estimate_tokens(
        [{"role": "assistant", "tool_calls": [{"function": {"name": "create_task", "arguments": "{}"}}]}],
        "",
    )
    assert with_tool > 0


@pytest.mark.asyncio
async def test_store_and_retrieve_memories(db_session: AsyncSession, ai_user):
    """WS6: stored memories are retrieved by keyword relevance; near-duplicate
    content is skipped by dedupe."""
    from app.services.memory_service import store_memories, retrieve_relevant_memories, purge_memories_for_session
    from sqlalchemy import select
    from uuid import UUID as _UUID
    from app.models.ai_memory import AiMemory

    user_id = str(ai_user)
    session_id = str(uuid4())
    user_uuid = _UUID(user_id)

    stored = await store_memories(db_session, user_id, session_id, [
        {"content": "User has a mechanic/ITV appointment on Tuesday 2026-08-04 at 16:00.", "category": "schedule"},
        {"content": "User prefers morning meetings.", "category": "preference"},
    ])
    assert stored == 2

    # An exact duplicate is skipped by dedupe.
    stored2 = await store_memories(db_session, user_id, str(uuid4()), [
        {"content": "User prefers morning meetings.", "category": "preference"},
    ])
    assert stored2 == 0

    relevant = await retrieve_relevant_memories(db_session, user_id, "mechanic appointment")
    assert any("mechanic" in m for m in relevant)

    # Rows exist in the DB.
    rows = (await db_session.execute(select(AiMemory).where(AiMemory.user_id == user_uuid))).scalars().all()
    assert len(rows) == 2

    # Purging the source session removes exactly those rows.
    purged = await purge_memories_for_session(db_session, user_id, session_id)
    assert purged == 2
    rows = (await db_session.execute(select(AiMemory).where(AiMemory.user_id == user_uuid))).scalars().all()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_memory_extraction_fail_open(db_session: AsyncSession, ai_user):
    """WS6: extraction failures must not raise or block anything."""
    from app.routers.ai import _maybe_extract_memories

    class _AlwaysFail:
        async def chat(self, messages, tools=None, **kwargs):
            raise RuntimeError("boom")

    facts = await _maybe_extract_memories(
        db_session, str(ai_user), str(uuid4()), _AlwaysFail(),
        [{"role": "user", "content": "hi"}], "hello", "A sufficiently long assistant reply string here.",
    )
    assert facts == []


@pytest.mark.asyncio
async def test_execute_create_task_no_conflict_self_match(db_session: AsyncSession, ai_user):
    """Creating a lone dated task must NOT be flagged as its own conflict. The
    DB-level `id != task.id` exclusion is unreliable across dialects, so the
    just-created task must be dropped explicitly (regression for spurious
    'this task conflicts with itself' warnings)."""
    user_id = str(ai_user)
    tool_calls = [{
        "id": "call_selfmatch",
        "function": {
            "name": "create_task",
            "arguments": json.dumps({"title": "Only Task On Day", "start_date": "2026-08-10"}),
        },
    }]
    results = await execute_tool_calls(tool_calls, user_id, db_session)
    content = json.loads(results[0]["content"])
    assert content["created"] is True
    assert "conflict_warning" not in content, f"lone task must not self-conflict: {content}"


@pytest.mark.asyncio
async def test_execute_search_tasks_capped(db_session: AsyncSession, ai_user):
    """WS4: search_tasks must be capped (TOOL_SEARCH_MAX), so huge result sets
    don't blow the context window."""
    from app.services.ai_service import TOOL_SEARCH_MAX
    from app.models.task import Task
    user_id = ai_user
    for i in range(30):
        db_session.add(Task(user_id=user_id, title=f"Searchable {i}"))
    await db_session.flush()

    tool_calls = [{
        "id": "call_cap",
        "function": {
            "name": "search_tasks",
            "arguments": json.dumps({"query": "Searchable"}),
        },
    }]
    results = await execute_tool_calls(tool_calls, str(user_id), db_session)
    content = json.loads(results[0]["content"])
    assert len(content["tasks"]) <= TOOL_SEARCH_MAX

