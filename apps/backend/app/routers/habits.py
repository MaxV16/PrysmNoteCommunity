from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.habit import Habit
from app.models.habit_log import HabitLog
from app.models.user import User

router = APIRouter(prefix="/api/habits", tags=["habits"])


class CreateHabitRequest(BaseModel):
    title: str
    frequency: str = "daily"
    target_count: int = 1
    color: str | None = None


class UpdateHabitRequest(BaseModel):
    title: str | None = None
    frequency: str | None = None
    target_count: int | None = None
    color: str | None = None


def _compute_streak(completion_dates: list[date]) -> int:
    if not completion_dates:
        return 0
    sorted_dates = sorted(set(completion_dates), reverse=True)
    today = date.today()
    expected = today
    streak = 0
    for d in sorted_dates:
        if d == expected:
            streak += 1
            expected -= timedelta(days=1)
        elif d < expected:
            break
    if sorted_dates[0] < today:
        return 0
    return streak


@router.get("/")
async def list_habits(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Habit).where(Habit.user_id == user.id)
    )
    habits = result.scalars().all()
    habit_ids = [h.id for h in habits]
    logs_result = await session.execute(
        select(HabitLog).where(HabitLog.habit_id.in_(habit_ids))
    )
    logs_by_habit: dict[str, list[date]] = {}
    for log in logs_result.scalars().all():
        logs_by_habit.setdefault(log.habit_id, []).append(log.completed_at)

    return [
        {
            "id": str(h.id),
            "title": h.title,
            "frequency": h.frequency,
            "target_count": h.target_count,
            "color": h.color,
            "streak": _compute_streak(logs_by_habit.get(h.id, [])),
            "created_at": h.created_at.isoformat(),
        }
        for h in habits
    ]


@router.post("/")
async def create_habit_route(
    request: CreateHabitRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    habit = Habit(
        user_id=user.id,
        title=request.title,
        frequency=request.frequency,
        target_count=request.target_count,
        color=request.color,
    )
    session.add(habit)
    await session.flush()
    return {
        "id": str(habit.id),
        "title": habit.title,
        "frequency": habit.frequency,
        "target_count": habit.target_count,
        "color": habit.color,
        "streak": 0,
        "created_at": habit.created_at.isoformat(),
    }


@router.patch("/{habit_id}")
async def update_habit_route(
    habit_id: str,
    request: UpdateHabitRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Habit).where(Habit.id == UUID(habit_id), Habit.user_id == user.id)
    )
    habit = result.scalar_one_or_none()
    if not habit:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Habit not found")
    if request.title is not None:
        habit.title = request.title
    if request.frequency is not None:
        habit.frequency = request.frequency
    if request.target_count is not None:
        habit.target_count = request.target_count
    if request.color is not None:
        habit.color = request.color
    await session.flush()

    logs_result = await session.execute(
        select(HabitLog).where(HabitLog.habit_id == UUID(habit_id))
    )
    streak = _compute_streak([log.completed_at for log in logs_result.scalars().all()])

    return {
        "id": str(habit.id),
        "title": habit.title,
        "frequency": habit.frequency,
        "target_count": habit.target_count,
        "color": habit.color,
        "streak": streak,
        "created_at": habit.created_at.isoformat(),
    }


@router.delete("/{habit_id}")
async def delete_habit_route(
    habit_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Habit).where(Habit.id == UUID(habit_id), Habit.user_id == user.id)
    )
    habit = result.scalar_one_or_none()
    if not habit:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Habit not found")
    await session.delete(habit)
    await session.flush()
    return {"status": "deleted"}


@router.post("/{habit_id}/log")
async def toggle_habit_log(
    habit_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    habit_result = await session.execute(
        select(Habit).where(Habit.id == UUID(habit_id), Habit.user_id == user.id)
    )
    habit = habit_result.scalar_one_or_none()
    if not habit:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Habit not found")

    today = date.today()
    existing_result = await session.execute(
        select(HabitLog).where(
            HabitLog.habit_id == UUID(habit_id),
            HabitLog.completed_at == today,
        )
    )
    existing_log = existing_result.scalar_one_or_none()

    if existing_log:
        await session.delete(existing_log)
        await session.flush()
        logged = False
    else:
        log = HabitLog(habit_id=UUID(habit_id), user_id=user.id, completed_at=today)
        session.add(log)
        await session.flush()
        logged = True

    logs_result = await session.execute(
        select(HabitLog).where(HabitLog.habit_id == UUID(habit_id))
    )
    streak = _compute_streak([log.completed_at for log in logs_result.scalars().all()])

    return {"logged": logged, "streak": streak, "date": today.isoformat()}


@router.get("/{habit_id}/logs")
async def get_habit_logs(
    habit_id: str,
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    habit_result = await session.execute(
        select(Habit).where(Habit.id == UUID(habit_id), Habit.user_id == user.id)
    )
    if not habit_result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Habit not found")

    query = select(HabitLog).where(HabitLog.habit_id == UUID(habit_id))
    if from_date:
        query = query.where(HabitLog.completed_at >= from_date)
    if to_date:
        query = query.where(HabitLog.completed_at <= to_date)
    query = query.order_by(HabitLog.completed_at)

    result = await session.execute(query)
    logs = result.scalars().all()

    return [
        {"id": str(log.id), "completed_at": log.completed_at.isoformat(), "created_at": log.created_at.isoformat()}
        for log in logs
    ]
