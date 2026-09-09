from datetime import date as date_type, time as time_type
from uuid import UUID

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus
from app.models.task_list import TaskList
from app.models.teams import TaskShare, TeamMember
from app.utils.priority import normalize_priority


def shared_task_ids_subquery(user_id: UUID):
    """Task ids the user can access through team memberships (task_shares)."""
    return (
        select(TaskShare.task_id)
        .join(TeamMember, TeamMember.team_id == TaskShare.team_id)
        .where(TeamMember.user_id == user_id)
    )


def task_access_condition(user_id: UUID):
    """Where-clause that lets a user see their own tasks plus tasks shared with
    any team they belong to."""
    return or_(
        Task.user_id == user_id,
        Task.id.in_(shared_task_ids_subquery(user_id)),
    )


def active_condition():
    """Where-clause excluding soft-deleted (trashed) tasks.

    Soft delete moves a task to the Trash view instead of removing the row, so
    EVERY normal task read must include this condition or trashed tasks leak
    back into the timeline/search/notifications. Trash-specific queries use the
    inverse (``deleted_at.isnot(None)``).
    """
    return Task.deleted_at.is_(None)


def validate_task_order(
    start_date: date_type | None,
    due_date: date_type | None,
    start_time: time_type | None,
    end_time: time_type | None,
) -> None:
    """Raise ValueError when the date/time range is inverted (A4).

    Rules (mirrored by the Pydantic model_validators in routers/tasks.py):
    - due_date must not be before start_date;
    - when the task resolves to a single day (no dates, one date, or equal
      dates), end_time must be strictly after start_time.
    """
    if start_date and due_date and due_date < start_date:
        raise ValueError("End date must be on or after the start date")
    if start_time and end_time:
        same_day = (start_date == due_date) if (start_date and due_date) else True
        if same_day and end_time <= start_time:
            raise ValueError("End time must be after the start time")


async def default_list_id(session: AsyncSession, user_id: UUID) -> UUID:
    """Return the user's default "My Tasks" list id, creating it lazily.

    New tasks without an explicit list land in this list. Idempotent: a user
    with no list yet gets exactly one, forever after it exists.
    """
    result = await session.execute(
        select(TaskList.id)
        .where(TaskList.user_id == user_id, TaskList.name == "My Tasks")
        .order_by(TaskList.position, TaskList.created_at)
        .limit(1)
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        return existing
    pos_result = await session.execute(
        select(func.max(TaskList.position)).where(TaskList.user_id == user_id)
    )
    default = TaskList(user_id=user_id, name="My Tasks", position=(pos_result.scalar() or 0) + 1)
    session.add(default)
    await session.flush()
    return default.id


def _parse_date(value: str | None) -> date_type | None:
    if value is None:
        return None
    try:
        return date_type.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def _parse_time(value: str | None) -> time_type | None:
    if value is None:
        return None
    # Accept "HH:MM" and "HH:MM:SS" (python time.fromisoformat needs the full
    # form for the latter; the former is its own ISO format).
    if isinstance(value, time_type):
        return value
    if isinstance(value, str):
        value = value.strip()
        if len(value) == 5 and value[2] == ":":
            value = f"{value}:00"
        try:
            return time_type.fromisoformat(value)
        except (ValueError, TypeError):
            return None
    return None


def _coerce_status(status: str | TaskStatus) -> TaskStatus:
    if isinstance(status, TaskStatus):
        return status
    return TaskStatus(status)


async def create_task(
    session: AsyncSession,
    user_id: UUID,
    title: str,
    parent_task_id: UUID | None = None,
    board_section_id: UUID | None = None,
    description: str | None = None,
    status: str = "backlog",
    priority: int = 2,
    start_date: str | None = None,
    due_date: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    recurrence_rule: str | None = None,
    recurrence_end_date: str | None = None,
    list_id: UUID | None = None,
) -> Task:
    # A recurring template must be anchored on a date to materialize. When the
    # caller gave no date but a rule, anchor at today so the series starts now.
    if recurrence_rule and not start_date:
        start_date = date_type.today().isoformat()

    # Ordering validation (A4): reject inverted date/time ranges before the row
    # is created - defense in depth behind the Pydantic model_validators.
    validate_task_order(
        _parse_date(start_date),
        _parse_date(due_date),
        _parse_time(start_time),
        _parse_time(end_time),
    )

    # List membership: an explicit list must belong to the user; otherwise the
    # task falls into the user's default "My Tasks" list.
    if list_id is not None:
        if not isinstance(list_id, UUID):
            list_id = _coerce_uuid(list_id)
        owned = await session.execute(
            select(TaskList.id).where(TaskList.id == list_id, TaskList.user_id == user_id)
        )
        if owned.scalar_one_or_none() is None:
            raise ValueError("List not found")
    else:
        list_id = await default_list_id(session, user_id)

    task = Task(
        user_id=user_id,
        parent_task_id=parent_task_id,
        board_section_id=board_section_id,
        title=title,
        description=description,
        status=_coerce_status(status),
        priority=normalize_priority(priority),
        start_date=_parse_date(start_date),
        due_date=_parse_date(due_date),
        start_time=_parse_time(start_time),
        end_time=_parse_time(end_time),
        recurrence_rule=recurrence_rule,
        recurrence_end_date=_parse_date(recurrence_end_date),
        list_id=list_id,
    )
    session.add(task)
    await session.flush()

    # Materialize upcoming occurrences up front so recurring templates (e.g.
    # "Mon-Fri", rotating weekend shifts) show their full week/cycle immediately.
    if recurrence_rule and parent_task_id is None:
        from app.services.recurring_task_service import expand_task_occurrences
        await expand_task_occurrences(session, task)

    return task


async def get_task(
    session: AsyncSession,
    task_id: UUID,
    user_id: UUID,
    include_trashed: bool = False,
) -> Task | None:
    task_id = _coerce_uuid(task_id)
    if task_id is None:
        return None
    stmt = select(Task).where(Task.id == task_id).where(task_access_condition(user_id))
    if not include_trashed:
        stmt = stmt.where(active_condition())
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


def _coerce_uuid(value: UUID | str | None) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


ALLOWED_UPDATE_FIELDS = {
    "title", "description", "status", "priority",
    "start_date", "due_date", "start_time", "end_time", "is_all_day", "estimated_minutes",
    "recurrence_rule", "recurrence_end_date", "sort_order",
    "parent_task_id", "is_archived", "board_section_id", "board_order",
    "list_id",
}


DATE_FIELDS = {"start_date", "due_date", "recurrence_end_date"}

TIME_FIELDS = {"start_time", "end_time"}


async def update_task(session: AsyncSession, task_id: UUID, fields: dict, user_id: UUID) -> Task | None:
    task = await get_task(session, task_id, user_id)
    if task is None:
        return None
    for key, value in fields.items():
        if key in ALLOWED_UPDATE_FIELDS:
            if key in DATE_FIELDS:
                value = _parse_date(value)
            if key in TIME_FIELDS:
                value = _parse_time(value)
            if key in ("parent_task_id", "board_section_id", "list_id") and value is not None:
                value = _coerce_uuid(value)
            if key == "status":
                value = _coerce_status(value)
            if key == "priority":
                value = normalize_priority(value)
            setattr(task, key, value)
    await session.flush()

    # Ordering validation (A4): if this update moves any date/time, re-check the
    # merged range and reject an inverted one.
    validate_task_order(
        task.start_date,
        task.due_date,
        task.start_time,
        task.end_time,
    )

    if "list_id" in fields and task.list_id is not None:
        owned = await session.execute(
            select(TaskList.id).where(TaskList.id == task.list_id, TaskList.user_id == user_id)
        )
        if owned.scalar_one_or_none() is None:
            raise ValueError("List not found")

    if task.recurrence_rule:
        if task.start_date is None:
            # Adding a rule to an undated task anchors the template at today so
            # the series is visible and expandable instead of silently inert.
            task.start_date = date_type.today()
        if task.parent_task_id is None:
            # Materialize occurrences immediately when a template was created or
            # re-enabled by this update, instead of waiting for the background loop.
            from app.services.recurring_task_service import expand_task_occurrences
            await expand_task_occurrences(session, task)

    return task


async def _apply_deleted(session: AsyncSession, task_ids: list[UUID], deleted: bool) -> set[UUID]:
    """Set (or clear) deleted_at on the given tasks AND their descendant tree.

    Soft-deleting a recurring template must trash its materialized occurrences
    too (a trashed template's children would otherwise linger as orphans); the
    inverse makes undo restore the whole tree.
    """
    task_ids = [t for t in task_ids if t is not None]
    if not task_ids:
        return set()
    affected: set[UUID] = set(task_ids)
    while True:
        children = await session.execute(
            select(Task.id).where(Task.parent_task_id.in_(affected))
        )
        child_ids = {row[0] for row in children.all()} - affected
        if not child_ids:
            break
        affected |= child_ids
    await session.execute(
        update(Task)
        .where(Task.id.in_(affected))
        .values(deleted_at=func.now() if deleted else None)
    )
    await session.flush()
    return affected


async def delete_task(session: AsyncSession, task_id: UUID, user_id: UUID) -> bool:
    """Soft-delete a task into the Trash view (reversible for 14 days).

    The row is kept with a deleted_at timestamp (descendants included);
    restore_task undoes it and the purge job hard-deletes it after the
    retention window.
    """
    task = await get_task(session, task_id, user_id)
    if task is None:
        return False
    await _apply_deleted(session, [task.id], deleted=True)
    return True


async def delete_tasks_batch(session: AsyncSession, task_ids: list[UUID], user_id: UUID) -> int:
    """Soft-delete many owned tasks (and their descendants) in one pass."""
    owned: list[UUID] = []
    for tid in task_ids:
        task = await get_task(session, tid, user_id)
        if task is not None:
            owned.append(task.id)
    if not owned:
        return 0
    affected = await _apply_deleted(session, owned, deleted=True)
    return len(owned)


async def restore_task(session: AsyncSession, task_id: UUID, user_id: UUID) -> bool:
    """Bring a trashed task (and its trashed descendants) back into the views."""
    task = await get_task(session, task_id, user_id, include_trashed=True)
    if task is None:
        return False
    await _apply_deleted(session, [task.id], deleted=False)
    return True


async def restore_tasks_batch(session: AsyncSession, task_ids: list[UUID], user_id: UUID) -> int:
    """Restore many trashed tasks (and their descendants) in one pass."""
    owned: list[UUID] = []
    for tid in task_ids:
        task = await get_task(session, tid, user_id, include_trashed=True)
        if task is not None:
            owned.append(task.id)
    if not owned:
        return 0
    await _apply_deleted(session, owned, deleted=False)
    return len(owned)


async def list_trashed(session: AsyncSession, user_id: UUID) -> list[Task]:
    """List the user's trashed tasks, newest first. Purging of expired rows
    (deleted_at older than the 14-day retention window) happens here too, so a
    trash view never shows stale entries even if the background job lagged."""
    await purge_trash(session, user_id)
    result = await session.execute(
        select(Task)
        .where(task_access_condition(user_id), Task.deleted_at.isnot(None))
        .order_by(Task.deleted_at.desc())
        .limit(500)
    )
    return list(result.scalars().all())


async def purge_trash(session: AsyncSession, user_id: UUID | None = None, retention_days: int = 14) -> int:
    """Hard-delete trashed tasks older than ``retention_days``.

    Runs in the background purge loop (user_id None = every user) and
    opportunistically inside list_trashed. Descendant subtasks of a purged
    template are collected and purged in the same pass so no orphan children
    survive.
    """
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import delete as sa_delete

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    stmt = select(Task.id).where(
        Task.deleted_at.isnot(None),
        Task.deleted_at < cutoff,
    )
    if user_id is not None:
        stmt = stmt.where(Task.user_id == user_id)
    result = await session.execute(stmt)
    expired = {row[0] for row in result.all()}
    if not expired:
        return 0

    # Purge descendants of expired templates too.
    while True:
        children = await session.execute(
            select(Task.id).where(Task.parent_task_id.in_(expired))
        )
        child_ids = {row[0] for row in children.all()} - expired
        if not child_ids:
            break
        expired |= child_ids

    if expired:
        await session.execute(sa_delete(Task).where(Task.id.in_(expired)))
        await session.flush()
    return len(expired)


async def empty_trash(session: AsyncSession, user_id: UUID) -> int:
    """Hard-delete EVERY task in the user's trash (irreversible)."""
    from sqlalchemy import delete as sa_delete

    result = await session.execute(
        sa_delete(Task).where(
            task_access_condition(user_id),
            Task.deleted_at.isnot(None),
        )
    )
    await session.flush()
    return result.rowcount or 0


async def set_task_dates_batch(
    session: AsyncSession,
    task_ids: list[UUID],
    user_id: UUID,
    date_value: date_type,
) -> int:
    """Assign start_date = due_date = date_value to every owned task in the batch."""
    task_ids = [t for t in task_ids if t is not None]
    if not task_ids:
        return 0
    result = await session.execute(
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids), active_condition())
    )
    tasks = result.scalars().all()
    for task in tasks:
        task.start_date = date_value
        task.due_date = date_value
    await session.flush()
    return len(tasks)


async def reschedule_tasks_batch(
    session: AsyncSession,
    task_ids: list[UUID],
    user_id: UUID,
    delta_days: int,
) -> int:
    """Shift dated tasks by a day delta; undated tasks land on today + delta.

    Mirrors TimelineView.handleDragEnd single-task semantics exactly so a
    single-drag and a multi-drag agree: shift whichever date exists, and when a
    task has neither, assign start_date = due_date = today + delta.
    """
    from datetime import timedelta

    task_ids = [t for t in task_ids if t is not None]
    if not task_ids:
        return 0
    result = await session.execute(
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids), active_condition())
    )
    by_id = {t.id: t for t in result.scalars().all()}
    today = date_type.today()
    delta = timedelta(days=delta_days)
    for task_id in task_ids:
        task = by_id.get(task_id)
        if task is None:
            continue
        if task.start_date:
            task.start_date = task.start_date + delta
        if task.due_date:
            task.due_date = task.due_date + delta
        if not task.start_date and not task.due_date:
            target = today + delta
            task.start_date = target
            task.due_date = target
    await session.flush()
    return len(by_id)


async def move_tasks_to_section(
    session: AsyncSession,
    task_ids: list[UUID],
    user_id: UUID,
    section_id: UUID | None,
    section_status: str | None,
    index: int,
) -> int:
    """Move a group of tasks into a board section (or the implicit "Unsorted"
    area when section_id is None) and renumber the destination once.

    Membership follows the single-task board-move rules: status sections set
    status (clearing the pin), free sections/Unsorted set board_section_id. The
    group keeps the caller's task_ids order, is spliced at `index`, then the
    whole destination sibling set is renumbered 0..n-1.
    """
    task_ids = [t for t in task_ids if t is not None]
    if not task_ids:
        return 0
    # Dedupe preserving order: a repeated id would otherwise splice the same task
    # into the destination twice (the UI never sends duplicates, but the route is
    # defensive anyway).
    seen: set[UUID] = set()
    deduped: list[UUID] = []
    for task_id in task_ids:
        if task_id in seen:
            continue
        seen.add(task_id)
        deduped.append(task_id)
    task_ids = deduped
    result = await session.execute(
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids), active_condition())
    )
    by_id = {t.id: t for t in result.scalars().all()}

    for task_id in task_ids:
        task = by_id.get(task_id)
        if task is None:
            continue
        if section_id is None or section_status is None:
            task.board_section_id = section_id
        else:
            task.status = _coerce_status(section_status)
            task.board_section_id = None

    if section_id is None:
        sibling_where = Task.board_section_id.is_(None)
    elif section_status:
        sibling_where = (Task.status == _coerce_status(section_status)) & Task.board_section_id.is_(None)
    else:
        sibling_where = Task.board_section_id == section_id

    result = await session.execute(
        select(Task)
        .where(task_access_condition(user_id), sibling_where, active_condition())
        .order_by(Task.board_order.asc().nulls_last(), Task.created_at.asc())
    )
    moved_ids = {task_id for task_id in task_ids if task_id in by_id}
    siblings = [t for t in result.scalars().all() if t.id not in moved_ids]
    index = max(0, min(index, len(siblings)))
    moved = [by_id[task_id] for task_id in task_ids if task_id in by_id]
    siblings[index:index] = moved
    for rank, task in enumerate(siblings):
        task.board_order = rank
    await session.flush()
    return len(moved)


async def search_tasks(
    session: AsyncSession, user_id: UUID, query: str, limit: int = 20
) -> list[tuple[Task, float]]:
    """Typos-tolerant, relevance-ranked task search.

    Uses pg_trgm trigram similarity (`%` operator) so short queries and typos
    still find matching titles/descriptions, ordered by best similarity. Falls
    back to an ILIKE substring path when pg_trgm is unavailable (e.g. SQLite).

    Returns ``(task, rank)`` pairs sorted by descending relevance, so callers
    can expose a ``rank`` field.
    """
    from sqlalchemy import or_, func, text as sa_text
    from app.models.tag import Tag
    from app.models.task_tag import TaskTag

    q_lower = (query or "").lower().strip()
    if not q_lower:
        return []

    try:
        # pg_trgm path: rank by the greater of title/description/tag-name similarity.
        tag_sim_subq = (
            select(func.max(func.similarity(func.lower(Tag.name), q_lower)))
            .select_from(TaskTag)
            .join(Tag, Tag.id == TaskTag.tag_id)
            .where(TaskTag.task_id == Task.id)
            .scalar_subquery()
        )
        stmt = (
            select(
                Task,
                func.greatest(
                    func.similarity(func.lower(Task.title), q_lower),
                    func.similarity(func.lower(func.coalesce(Task.description, "")), q_lower),
                    func.coalesce(tag_sim_subq, 0),
                ).label("rank"),
            )
            .where(
                task_access_condition(user_id),
                active_condition(),
                or_(
                    func.lower(Task.title) % q_lower,
                    func.lower(func.coalesce(Task.description, "")) % q_lower,
                    Task.id.in_(
                        select(TaskTag.task_id)
                        .join(Tag, Tag.id == TaskTag.tag_id)
                        .where(func.lower(Tag.name) % q_lower)
                    ),
                ),
            )
            .order_by(sa_text("rank DESC"))
            .limit(limit)
        )
        result = await session.execute(stmt)
        rows = result.all()
        ranked = [(row[0], float(row[1])) for row in rows]
    except Exception:
        # pg_trgm missing or dialect unsupported -> plain substring fallback.
        stmt = (
            select(Task)
            .where(
                task_access_condition(user_id),
                active_condition(),
                or_(
                    Task.title.ilike(func.concat('%', query, '%')),
                    Task.description.ilike(func.concat('%', query, '%')),
                    Task.id.in_(
                        select(TaskTag.task_id)
                        .join(Tag, Tag.id == TaskTag.tag_id)
                        .where(Tag.name.ilike(func.concat('%', query, '%')))
                    ),
                ),
            )
            .limit(limit)
        )
        result = await session.execute(stmt)
        ranked = [(t, 0.0) for t in result.scalars().all()]

    # Sort by rank descending (best match first) for the fallback path too.
    ranked.sort(key=lambda r: r[1], reverse=True)
    return ranked
