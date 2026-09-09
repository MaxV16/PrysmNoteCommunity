import asyncio
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from dateutil.rrule import rrulestr
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.task import Task, TaskStatus

# How many days of future occurrences a recurring template materializes up front
# (the initial/background window). A ~3-month horizon (~90 days) makes an endless
# daily series look continuous in every view without flooding the schedule with an
# unlimited recurrence. Farther dates are materialized lazily by
# expand_recurring_for_range when a view asks for them.
INITIAL_HORIZON_DAYS = 90

# Maximum number of occurrences to create per template in one pass (safety cap).
MAX_OCCURRENCES = 104

# Per-template cap for an on-demand lazy expansion (a view scrolled far ahead).
# Larger than the background cap because it is a user-initiated read of a specific
# window, but still bounded so one template cannot flood the request.
MAX_OCCURRENCES_ON_DEMAND = 200


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
    if not task.recurrence_rule:
        return 0

    today = date.today()
    if task.recurrence_end_date and task.recurrence_end_date < today:
        return 0

    if task.start_date is None:
        # A template with no date is anchored at today so an endless series
        # actually starts materializing instead of silently doing nothing.
        task.start_date = today
        await session.flush()

    from_date = max(task.start_date, today)
    horizon_date = from_date + timedelta(days=INITIAL_HORIZON_DAYS)

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
            start_time=task.start_time,
            end_time=task.end_time,
            parent_task_id=task.id,
        )
        session.add(new_task)

    await session.flush()
    return len(to_create)


async def expand_task_occurrences_for_range(
    session: AsyncSession, task: Task, from_date: date, to_date: date
) -> int:
    """Create missing occurrences of a template that fall inside ``[from_date, to_date]``.

    Lazy counterpart of ``expand_task_occurrences``: instead of a horizon window
    anchored at today, it materializes only the instances a view actually asked
    for. Idempotent (same ``(parent_task_id, start_date)`` uniqueness check) and
    does NOT stamp ``recurrence_last_expanded_at``, so the background loop's
    cooldown semantics stay untouched.

    The rule iteration budget is sized to reach ``to_date`` (a far lazy window can
    lie thousands of days past ``start_date``), but the number of rows actually
    created is capped by ``MAX_OCCURRENCES_ON_DEMAND``.
    """
    if not task.recurrence_rule:
        return 0
    if task.start_date is None:
        # Same anchoring invariant as expand_task_occurrences: an undated endless
        # template starts from today so the lazy window can materialize it.
        task.start_date = date.today()
        await session.flush()
    if to_date < task.start_date:
        return 0

    # Iterating the rule from the template's real start keeps COUNT/UNTIL and
    # relative recurrence semantics anchored correctly. The budget is the day
    # distance to the window (the exact iteration count for daily rules), with a
    # floor so even a template starting today can fill the requested window.
    iteration_budget = max(
        MAX_OCCURRENCES_ON_DEMAND, (to_date - task.start_date).days + 1
    )
    instances = expand_recurring_instances(
        task.start_date,
        task.recurrence_rule,
        task.recurrence_end_date,
        max_occurrences=iteration_budget,
        horizon_date=to_date,
    )

    in_range = [
        date.fromisoformat(i["start_date"])
        for i in instances
        if from_date <= date.fromisoformat(i["start_date"]) <= to_date
    ]
    if not in_range:
        return 0

    # The template row itself is the occurrence for its start_date; never spawn
    # a duplicate child for it.
    candidate_dates = {d for d in in_range if d != task.start_date}
    if len(candidate_dates) > MAX_OCCURRENCES_ON_DEMAND:
        candidate_dates = set(sorted(candidate_dates)[:MAX_OCCURRENCES_ON_DEMAND])

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
            start_time=task.start_time,
            end_time=task.end_time,
            parent_task_id=task.id,
        )
        session.add(new_task)

    await session.flush()
    return len(to_create)


async def expand_recurring_for_range(
    session: AsyncSession,
    user_id: UUID | None,
    from_date: date,
    to_date: date,
) -> int:
    """Materialize missing recurring occurrences for ``user_id`` inside a date window.

    Called lazily from a view/API read (timeline scroll, date-range lookups) so
    endless recurrences grow on demand instead of being pre-flooded. Does NOT
    stamp ``recurrence_last_expanded_at``: that column gates only the background
    loop's cooldown and must not be advanced by on-demand reads, or the hourly
    pass would prematurely skip a template. One failing template must not abort
    the batch.
    """
    stmt = select(Task).where(
        Task.recurrence_rule.isnot(None),
        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
        Task.deleted_at.is_(None),
        or_(Task.recurrence_end_date.is_(None), Task.recurrence_end_date >= from_date),
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
        try:
            created += await expand_task_occurrences_for_range(session, task, from_date, to_date)
        except Exception:
            # Keep going; one template's failure must not block the rest.
            pass

    return created


async def expand_recurring_tasks(session: AsyncSession, user_id: UUID | None = None) -> int:
    """Find all active recurring templates and materialize their upcoming occurrences.

    Templates whose expansion is more recent than ``recurring_expand_cooldown_hours``
    are skipped (the background loop still runs hourly, but each template is
    scanned at most once per cooldown window), and ended templates are never
    scanned at all. The cooldown column is stamped after a successful expansion.
    """
    cooldown_cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.recurring_expand_cooldown_hours)
    stmt = select(Task).where(
        Task.recurrence_rule.isnot(None),
        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
        Task.deleted_at.is_(None),
        or_(Task.recurrence_end_date.is_(None), Task.recurrence_end_date >= date.today()),
        or_(
            Task.recurrence_last_expanded_at.is_(None),
            Task.recurrence_last_expanded_at < cooldown_cutoff,
        ),
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
        try:
            created += await expand_task_occurrences(session, task)
            task.recurrence_last_expanded_at = datetime.now(timezone.utc)
        except Exception:
            # Leave the timestamp unset on failure so the next pass retries.
            pass

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