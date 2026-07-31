import asyncio
from datetime import date, datetime, timezone
from uuid import UUID

from dateutil.rrule import rrulestr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus


def expand_recurring_instances(
    start_date: date,
    recurrence_rule: str,
    recurrence_end_date: date | None = None,
    max_occurrences: int = 52,
) -> list[dict]:
    dtstart = datetime.combine(start_date, datetime.min.time())

    rule = rrulestr(f"RRULE:{recurrence_rule}", dtstart=dtstart)
    instances = []

    for dt in rule:
        if len(instances) >= max_occurrences:
            break
        if recurrence_end_date and dt.date() > recurrence_end_date:
            break
        instance_date = dt.date()
        if instance_date < start_date:
            continue
        instances.append({
            "start_date": instance_date.isoformat(),
            "due_date": instance_date.isoformat(),
        })

    return instances


def compute_next_occurrence(
    start_date: date,
    recurrence_rule: str,
    recurrence_end_date: date | None = None,
) -> date | None:
    instances = expand_recurring_instances(
        start_date=start_date,
        recurrence_rule=recurrence_rule,
        recurrence_end_date=recurrence_end_date,
        max_occurrences=10,
    )
    today = date.today()
    for inst in instances:
        inst_date = date.fromisoformat(inst["start_date"])
        if inst_date >= today:
            return inst_date
    return None


async def expand_recurring_tasks(session: AsyncSession, user_id: UUID | None = None) -> int:
    """Find all active recurring tasks and create their next occurrence if needed."""
    stmt = select(Task).where(
        Task.recurrence_rule.isnot(None),
        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
    )
    if user_id:
        stmt = stmt.where(Task.user_id == user_id)

    result = await session.execute(stmt)
    tasks = result.scalars().all()
    created = 0

    for task in tasks:
        if not task.start_date or not task.recurrence_rule:
            continue

        next_date = compute_next_occurrence(
            task.start_date,
            task.recurrence_rule,
            task.recurrence_end_date,
        )
        if next_date is None:
            continue

        # Check if an occurrence already exists for this date
        existing = await session.execute(
            select(Task).where(
                Task.parent_task_id == task.id,
                Task.start_date == next_date,
            )
        )
        if existing.scalar_one_or_none():
            continue

        new_task = Task(
            user_id=task.user_id,
            project_id=task.project_id,
            title=task.title,
            description=task.description,
            status=TaskStatus.TODO,
            priority=task.priority,
            start_date=next_date,
            due_date=next_date,
            parent_task_id=task.id,
        )
        session.add(new_task)
        created += 1

    if created > 0:
        await session.flush()

    return created


async def recurring_task_background_loop(session_factory):
    """Background loop that expands recurring tasks every hour."""
    while True:
        try:
            async with session_factory() as session:
                count = await expand_recurring_tasks(session)
                await session.commit()
                if count > 0:
                    print(f"[recurring] Expanded {count} recurring task(s)")
        except Exception as e:
            print(f"[recurring] Error: {e}")
        await asyncio.sleep(3600)  # every hour