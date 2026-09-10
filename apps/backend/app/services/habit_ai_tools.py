"""Habits tools surfaced to the in-app AI agent (core, free).

Follows the watchlist pattern: exports the triple (`_SYSTEM_NOTE`,
`_TOOL_DEFINITIONS`, `_TOOL_HANDLERS`) and is imported unconditionally by
``ai_service.py`` so every AI user can manage habits. Handlers take
``(args, user_id, session)`` and return JSON-serializable dicts; the session is
already RLS-keyed.

This module ships in the community build, so it must stay 100% open-core.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select

from app.models.habit import Habit
from app.models.habit_log import HabitLog
from app.routers.habits import _compute_streak
from app.utils.uuid_helpers import parse_uuid

VALID_FREQUENCIES = {"daily", "weekly", "monthly"}

HABIT_SYSTEM_NOTE = (
    "HABITS: You can manage the user's habits (daily/weekly/monthly trackers with "
    "streaks). Decode habit intent: \"track drinking water daily\" -> "
    "create_habit (frequency daily); \"I did my workout today\" / \"log my run\" "
    "-> toggle_habit_log for that habit; \"what are my habits / show my habits / "
    "how's my streak\" -> list_habits; \"update/change my habit\" -> "
    "update_habit. Deleting a habit is DESTRUCTIVE (it removes its history too): "
    "do NOT delete in the same turn - list the exact habit you will remove, ask "
    "the user to confirm, and only call delete_habit in a LATER turn once they "
    "explicitly confirm. Never claim an add/update/log/delete succeeded unless "
    "the tool returned the matching success flag (created/updated/logged/deleted)."
)

HABIT_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "list_habits",
            "description": "List the user's habits with their current streak. Use whenever the user asks about their habits, streaks, or tracking progress.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_habit",
            "description": "Create a new habit tracker. frequency is daily, weekly or monthly; target_count is how many completions count per period (default 1); color is an optional hex string.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "frequency": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                    "target_count": {"type": "integer", "description": "default 1"},
                    "color": {"type": "string", "description": "optional hex color like #4FC3F7"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_habit",
            "description": "Update an existing habit's title, frequency, target_count or color. Only include fields that changed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "habit_id": {"type": "string"},
                    "title": {"type": "string"},
                    "frequency": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                    "target_count": {"type": "integer"},
                    "color": {"type": "string"},
                },
                "required": ["habit_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_habit",
            "description": "Permanently delete a habit and its entire log history. DESTRUCTIVE: require explicit user confirmation before calling. Never delete a habit the user merely said they are skipping - confirm first.",
            "parameters": {
                "type": "object",
                "properties": {"habit_id": {"type": "string"}},
                "required": ["habit_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggle_habit_log",
            "description": "Log today's completion for a habit (toggles: logging an already-logged day removes it). Use when the user says they did/completed a habit today. Returns logged, the updated streak and the date.",
            "parameters": {
                "type": "object",
                "properties": {"habit_id": {"type": "string"}},
                "required": ["habit_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_habit_logs",
            "description": "List the completion log dates for a habit, optionally filtered by a date range (YYYY-MM-DD).",
            "parameters": {
                "type": "object",
                "properties": {
                    "habit_id": {"type": "string"},
                    "from": {"type": "string", "description": "YYYY-MM-DD, optional"},
                    "to": {"type": "string", "description": "YYYY-MM-DD, optional"},
                },
                "required": ["habit_id"],
            },
        },
    },
]


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _habit_dict(habit: Habit, streak: int) -> dict:
    return {
        "id": str(habit.id),
        "title": habit.title,
        "frequency": habit.frequency,
        "target_count": habit.target_count,
        "color": habit.color,
        "streak": streak,
        "created_at": habit.created_at.isoformat(),
    }


async def _list_habits(args: dict, user_id: str, session) -> dict:
    result = await session.execute(select(Habit).where(Habit.user_id == UUID(user_id)))
    habits = result.scalars().all()
    habit_ids = [h.id for h in habits]
    cutoff = date.today() - timedelta(days=730)
    logs_result = await session.execute(
        select(HabitLog).where(
            HabitLog.habit_id.in_(habit_ids),
            HabitLog.completed_at >= cutoff,
        )
    )
    logs_by_habit: dict[str, list[date]] = {}
    for log in logs_result.scalars().all():
        logs_by_habit.setdefault(log.habit_id, []).append(log.completed_at)
    return {
        "count": len(habits),
        "habits": [
            _habit_dict(h, _compute_streak(logs_by_habit.get(h.id, [])))
            for h in habits
        ],
    }


async def _create_habit(args: dict, user_id: str, session) -> dict:
    title = str(args.get("title") or "").strip()
    if not title:
        return {"error": "title is required."}
    frequency = str(args.get("frequency") or "daily")
    if frequency not in VALID_FREQUENCIES:
        return {"error": "frequency must be daily, weekly or monthly"}
    try:
        target_count = int(args.get("target_count") or 1)
    except (TypeError, ValueError):
        target_count = 1
    if target_count < 1:
        target_count = 1
    habit = Habit(
        user_id=UUID(user_id),
        title=title,
        frequency=frequency,
        target_count=target_count,
        color=args.get("color"),
    )
    session.add(habit)
    await session.flush()
    return {"created": True, "habit": _habit_dict(habit, 0)}


async def _update_habit(args: dict, user_id: str, session) -> dict:
    habit_uuid = parse_uuid(str(args.get("habit_id") or ""))
    if habit_uuid is None:
        return {"error": "Invalid habit_id format"}
    result = await session.execute(
        select(Habit).where(Habit.id == habit_uuid, Habit.user_id == UUID(user_id))
    )
    habit = result.scalar_one_or_none()
    if habit is None:
        return {"error": "Habit not found"}
    if "title" in args and args.get("title") is not None:
        title = str(args["title"]).strip()
        if not title:
            return {"error": "title cannot be empty"}
        habit.title = title
    if "frequency" in args and args.get("frequency") is not None:
        frequency = str(args["frequency"])
        if frequency not in VALID_FREQUENCIES:
            return {"error": "frequency must be daily, weekly or monthly"}
        habit.frequency = frequency
    if "target_count" in args and args.get("target_count") is not None:
        try:
            habit.target_count = max(1, int(args["target_count"]))
        except (TypeError, ValueError):
            return {"error": "target_count must be an integer >= 1"}
    if "color" in args:
        habit.color = args.get("color")
    logs_result = await session.execute(
        select(HabitLog).where(HabitLog.habit_id == habit_uuid)
    )
    streak = _compute_streak([log.completed_at for log in logs_result.scalars().all()])
    await session.flush()
    return {"updated": True, "habit": _habit_dict(habit, streak)}


async def _delete_habit(args: dict, user_id: str, session) -> dict:
    habit_uuid = parse_uuid(str(args.get("habit_id") or ""))
    if habit_uuid is None:
        return {"error": "Invalid habit_id format"}
    result = await session.execute(
        select(Habit).where(Habit.id == habit_uuid, Habit.user_id == UUID(user_id))
    )
    habit = result.scalar_one_or_none()
    if habit is None:
        return {"error": "Habit not found"}
    await session.delete(habit)
    await session.flush()
    return {"deleted": True, "habit_id": str(habit.id)}


async def _toggle_habit_log(args: dict, user_id: str, session) -> dict:
    habit_uuid = parse_uuid(str(args.get("habit_id") or ""))
    if habit_uuid is None:
        return {"error": "Invalid habit_id format"}
    result = await session.execute(
        select(Habit).where(Habit.id == habit_uuid, Habit.user_id == UUID(user_id))
    )
    habit = result.scalar_one_or_none()
    if habit is None:
        return {"error": "Habit not found"}

    today = date.today()
    existing_result = await session.execute(
        select(HabitLog).where(
            HabitLog.habit_id == habit_uuid,
            HabitLog.completed_at == today,
        )
    )
    existing_log = existing_result.scalar_one_or_none()

    if existing_log:
        await session.delete(existing_log)
        await session.flush()
        logged = False
    else:
        log = HabitLog(habit_id=habit_uuid, user_id=UUID(user_id), completed_at=today)
        session.add(log)
        await session.flush()
        logged = True

    logs_result = await session.execute(
        select(HabitLog).where(HabitLog.habit_id == habit_uuid)
    )
    streak = _compute_streak([log.completed_at for log in logs_result.scalars().all()])
    return {"logged": logged, "streak": streak, "date": today.isoformat()}


async def _get_habit_logs(args: dict, user_id: str, session) -> dict:
    habit_uuid = parse_uuid(str(args.get("habit_id") or ""))
    if habit_uuid is None:
        return {"error": "Invalid habit_id format"}
    result = await session.execute(
        select(Habit).where(Habit.id == habit_uuid, Habit.user_id == UUID(user_id))
    )
    if result.scalar_one_or_none() is None:
        return {"error": "Habit not found"}

    query = select(HabitLog).where(HabitLog.habit_id == habit_uuid)
    from_date = _parse_date(args.get("from"))
    to_date = _parse_date(args.get("to"))
    if from_date:
        query = query.where(HabitLog.completed_at >= from_date)
    if to_date:
        query = query.where(HabitLog.completed_at <= to_date)
    query = query.order_by(HabitLog.completed_at)

    result = await session.execute(query)
    logs = result.scalars().all()
    return {
        "habit_id": str(habit_uuid),
        "count": len(logs),
        "logs": [
            {"id": str(log.id), "completed_at": log.completed_at.isoformat()}
            for log in logs
        ],
    }


HABIT_TOOL_HANDLERS = {
    "list_habits": _list_habits,
    "create_habit": _create_habit,
    "update_habit": _update_habit,
    "delete_habit": _delete_habit,
    "toggle_habit_log": _toggle_habit_log,
    "get_habit_logs": _get_habit_logs,
}