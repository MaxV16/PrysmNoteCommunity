import asyncio
from datetime import date, datetime, timedelta
from uuid import UUID

from dateutil.rrule import rrulestr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus

# How many days of future occurrences a recurring template materializes up front.
# An 8-week horizon lets the full Mon-Fri week and a 3-week rotating-shift cycle be
# visible immediately, without flooding the schedule with an unlimited recurrence.
HORIZON_DAYS = 56

# Maximum number of occurrences to create per template in one pass (safety cap).
MAX_OCCURRENCES = 104


def expand_recurring_instances(
    start_date: date,
    recurrence_rule: str,
    recurrence_end_date: date | None = None,
    max_occurrences: int = 52,
    horizon_date: date | None = None,
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
        if horizon_date and instance_date > horizon_date:
            break
        instances.append({
            "start_date": instance_date.isoformat(),
            "due_date": instance_date.isoformat(),
        })

    return instances


async def expand_task_occurrences(session: AsyncSession, task: Task) -> int:
    """Create all missing occurrences for a single recurring template up to the horizon.

    Returns how many child tasks were created. Idempotent: re-running skips dates that
    already have a child task linked by ``parent_task_id`` + ``start_date``.
    """
    if not task.start_date or not task.recurrence_rule:
        return 0

    today = date.today()
    if task.recurrence_end_date and task.recurrence_end_date < today:
        return 0

    from_date = max(task.start_date, today)
    horizon_date = from_date + timedelta(days=HORIZON_DAYS)

    instances = expand_recurring_instances(
        task.start_date,
        task.recurrence_rule,
        task.recurrence_end_date,
        max_occurrences=MAX_OCCURRENCES,
        horizon_date=horizon_date,
    )

    candidate_dates = {date.fromisoformat(i["start_date"]) for i in instances}
    if not candidate_dates:
        return 0

    # The template row itself is the occurrence for its start_date (it already
    # exists on that calendar day), so never spawn a duplicate child for it.
    candidate_dates.discard(task.start_date)

    existing_child = await session.execute(
        select(Task.start_date).where(Task.parent_task_id == task.id)
    )
    existing_dates = set(existing_child.scalars().all())

    to_create = sorted(candidate_dates - existing_dates)
    if not to_create:
        return 0

    for instance_date in to_create:
        new_task = Task(
            user_id=task.user_id,
            title=task.title,
            description=task.description,
            status=TaskStatus.TODO,
            priority=task.priority,
            start_date=instance_date,
            due_date=instance_date,
            parent_task_id=task.id,
        )
        session.add(new_task)

    await session.flush()
    return len(to_create)


async def expand_recurring_tasks(session: AsyncSession, user_id: UUID | None = None) -> int:
    """Find all active recurring templates and materialize their upcoming occurrences."""
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
        if task.parent_task_id is not None:
            # Child occurrences aren't templates; skip them.
            continue
        created += await expand_task_occurrences(session, task)

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