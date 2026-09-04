from datetime import date as date_type
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus
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


def _parse_date(value: str | None) -> date_type | None:
    if value is None:
        return None
    try:
        return date_type.fromisoformat(value)
    except (ValueError, TypeError):
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
    recurrence_rule: str | None = None,
    recurrence_end_date: str | None = None,
) -> Task:
    # A recurring template must be anchored on a date to materialize. When the
    # caller gave no date but a rule, anchor at today so the series starts now.
    if recurrence_rule and not start_date:
        start_date = date_type.today().isoformat()

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
        recurrence_rule=recurrence_rule,
        recurrence_end_date=_parse_date(recurrence_end_date),
    )
    session.add(task)
    await session.flush()

    # Materialize upcoming occurrences up front so recurring templates (e.g.
    # "Mon-Fri", rotating weekend shifts) show their full week/cycle immediately.
    if recurrence_rule and parent_task_id is None:
        from app.services.recurring_task_service import expand_task_occurrences
        await expand_task_occurrences(session, task)

    return task


async def get_task(session: AsyncSession, task_id: UUID, user_id: UUID) -> Task | None:
    task_id = _coerce_uuid(task_id)
    if task_id is None:
        return None
    result = await session.execute(
        select(Task).where(Task.id == task_id).where(task_access_condition(user_id))
    )
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
    "start_date", "due_date", "is_all_day", "estimated_minutes",
    "recurrence_rule", "recurrence_end_date", "sort_order",
    "parent_task_id", "is_archived", "board_section_id", "board_order",
}


DATE_FIELDS = {"start_date", "due_date", "recurrence_end_date"}


async def update_task(session: AsyncSession, task_id: UUID, fields: dict, user_id: UUID) -> Task | None:
    task = await get_task(session, task_id, user_id)
    if task is None:
        return None
    for key, value in fields.items():
        if key in ALLOWED_UPDATE_FIELDS:
            if key in DATE_FIELDS:
                value = _parse_date(value)
            if key == "status":
                value = _coerce_status(value)
            if key == "priority":
                value = normalize_priority(value)
            setattr(task, key, value)
    await session.flush()

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


async def delete_task(session: AsyncSession, task_id: UUID, user_id: UUID) -> bool:
    task = await get_task(session, task_id, user_id)
    if task is None:
        return False
    await session.delete(task)
    await session.flush()
    return True


async def delete_tasks_batch(session: AsyncSession, task_ids: list[UUID], user_id: UUID) -> int:
    """Delete many owned tasks in one pass. Returns the number deleted."""
    task_ids = [t for t in task_ids if t is not None]
    if not task_ids:
        return 0
    result = await session.execute(
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids))
    )
    tasks = result.scalars().all()
    for task in tasks:
        await session.delete(task)
    await session.flush()
    return len(tasks)


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
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids))
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
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids))
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
    result = await session.execute(
        select(Task).where(task_access_condition(user_id), Task.id.in_(task_ids))
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
        .where(task_access_condition(user_id), sibling_where)
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
