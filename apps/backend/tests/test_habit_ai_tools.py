"""Tests for the in-app AI habit tools (core, free).

Habits are a core (open-core) feature: their AI tools are imported
unconditionally by ``ai_service.py`` and must never be EE-gated (no premium
checking, no ee identifiers). Handlers run with the session RLS-keyed to the
``ai_user`` fixture; cross-user isolation is asserted by seeding another user's
habit.
"""
import json
from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.habit import Habit
from app.models.habit_log import HabitLog
from app.models.user import User
from app.services.habit_ai_tools import (
    HABIT_TOOL_DEFINITIONS,
    HABIT_TOOL_HANDLERS,
    HABIT_SYSTEM_NOTE,
)

TOOL_NAMES = {t["function"]["name"] for t in HABIT_TOOL_DEFINITIONS}


async def _add_habit(session, user_id, *, title="Read daily", frequency="daily"):
    habit = Habit(user_id=user_id, title=title, frequency=frequency, target_count=1)
    session.add(habit)
    await session.flush()
    return habit


@pytest.mark.asyncio
async def test_tool_set_contains_six_habit_tools():
    assert TOOL_NAMES == {
        "list_habits",
        "create_habit",
        "update_habit",
        "delete_habit",
        "toggle_habit_log",
        "get_habit_logs",
    }
    assert "DESTRUCTIVE" in HABIT_SYSTEM_NOTE


@pytest.mark.asyncio
async def test_create_habit_then_list_with_streak(db_session: AsyncSession, ai_user):
    created = await HABIT_TOOL_HANDLERS["create_habit"](
        {"title": "Drink water", "frequency": "daily", "color": "#22C55E"},
        str(ai_user),
        db_session,
    )
    assert created["created"] is True
    assert created["habit"]["title"] == "Drink water"
    assert created["habit"]["streak"] == 0

    listed = await HABIT_TOOL_HANDLERS["list_habits"]({}, str(ai_user), db_session)
    assert listed["count"] == 1
    assert listed["habits"][0]["title"] == "Drink water"


@pytest.mark.asyncio
async def test_create_habit_validates(db_session: AsyncSession, ai_user):
    payload = await HABIT_TOOL_HANDLERS["create_habit"]({"title": ""}, str(ai_user), db_session)
    assert "error" in payload

    payload = await HABIT_TOOL_HANDLERS["create_habit"](
        {"title": "X", "frequency": "fortnightly"}, str(ai_user), db_session
    )
    assert "error" in payload


@pytest.mark.asyncio
async def test_toggle_habit_log_toggles_and_returns_streak(db_session: AsyncSession, ai_user):
    habit = await _add_habit(db_session, ai_user)

    logged = await HABIT_TOOL_HANDLERS["toggle_habit_log"]({"habit_id": str(habit.id)}, str(ai_user), db_session)
    assert logged["logged"] is True
    assert logged["date"] == date.today().isoformat()
    assert logged["streak"] == 1

    # Toggling again removes today's log.
    unlogged = await HABIT_TOOL_HANDLERS["toggle_habit_log"]({"habit_id": str(habit.id)}, str(ai_user), db_session)
    assert unlogged["logged"] is False
    assert unlogged["streak"] == 0


@pytest.mark.asyncio
async def test_toggle_habit_log_respects_ownership(db_session: AsyncSession, ai_user):
    other = User(id=uuid4(), email=f"hab-{uuid4().hex[:8]}@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_habit = await _add_habit(db_session, other.id, title="Secret habit")

    payload = await HABIT_TOOL_HANDLERS["toggle_habit_log"]({"habit_id": str(other_habit.id)}, str(ai_user), db_session)
    assert payload["error"] == "Habit not found"


@pytest.mark.asyncio
async def test_update_habit(db_session: AsyncSession, ai_user):
    habit = await _add_habit(db_session, ai_user, title="Old")
    payload = await HABIT_TOOL_HANDLERS["update_habit"](
        {"habit_id": str(habit.id), "title": "New", "frequency": "weekly"},
        str(ai_user),
        db_session,
    )
    assert payload["updated"] is True
    assert payload["habit"]["title"] == "New"
    assert payload["habit"]["frequency"] == "weekly"


@pytest.mark.asyncio
async def test_delete_habit_and_logs(db_session: AsyncSession, ai_user):
    habit = await _add_habit(db_session, ai_user)
    log = HabitLog(habit_id=habit.id, user_id=ai_user, completed_at=date.today())
    db_session.add(log)
    await db_session.flush()

    payload = await HABIT_TOOL_HANDLERS["delete_habit"]({"habit_id": str(habit.id)}, str(ai_user), db_session)
    assert payload["deleted"] is True

    rows = (await db_session.execute(select(HabitLog).where(HabitLog.habit_id == habit.id))).scalars().all()
    assert rows == []

    again = await HABIT_TOOL_HANDLERS["delete_habit"]({"habit_id": str(habit.id)}, str(ai_user), db_session)
    assert again["error"] == "Habit not found"


@pytest.mark.asyncio
async def test_get_habit_logs_filters_range(db_session: AsyncSession, ai_user):
    habit = await _add_habit(db_session, ai_user)
    older = date.today() - timedelta(days=4)
    db_session.add_all([
        HabitLog(habit_id=habit.id, user_id=ai_user, completed_at=older),
        HabitLog(habit_id=habit.id, user_id=ai_user, completed_at=date.today()),
    ])
    await db_session.flush()

    all_logs = await HABIT_TOOL_HANDLERS["get_habit_logs"]({"habit_id": str(habit.id)}, str(ai_user), db_session)
    assert all_logs["count"] == 2

    recent = await HABIT_TOOL_HANDLERS["get_habit_logs"](
        {"habit_id": str(habit.id), "from": date.today().isoformat()}, str(ai_user), db_session
    )
    assert recent["count"] == 1

    empty = await HABIT_TOOL_HANDLERS["get_habit_logs"](
        {"habit_id": str(habit.id), "to": (date.today() - timedelta(days=10)).isoformat()},
        str(ai_user),
        db_session,
    )
    assert empty["count"] == 0


@pytest.mark.asyncio
async def test_tools_are_json_serializable(db_session: AsyncSession, ai_user):
    from app.services import ai_service

    # The habit handlers must be reachable through execute_tool_calls, the real
    # dispatch path the AI agent uses.
    habit = await _add_habit(db_session, ai_user)
    results = await ai_service.execute_tool_calls([
        {"id": "c1", "function": {"name": "toggle_habit_log", "arguments": json.dumps({"habit_id": str(habit.id)})}},
    ], str(ai_user), db_session)
    content = json.loads(results[0]["content"])
    assert content["logged"] is True