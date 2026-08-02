from datetime import date as date_type
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus
from app.utils.priority import normalize_priority


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
    description: str | None = None,
    status: str = "backlog",
    priority: int = 2,
    start_date: str | None = None,
    due_date: str | None = None,
    recurrence_rule: str | None = None,
) -> Task:
    task = Task(
        user_id=user_id,
        parent_task_id=parent_task_id,
        title=title,
        description=description,
        status=_coerce_status(status),
        priority=normalize_priority(priority),
        start_date=_parse_date(start_date),
        due_date=_parse_date(due_date),
        recurrence_rule=recurrence_rule,
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
    result = await session.execute(
        select(Task).where(Task.id == task_id, Task.user_id == user_id)
    )
    return result.scalar_one_or_none()


ALLOWED_UPDATE_FIELDS = {
    "title", "description", "status", "priority",
    "start_date", "due_date", "is_all_day", "estimated_minutes",
    "recurrence_rule", "recurrence_end_date", "sort_order",
    "parent_task_id", "is_archived",
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
    return task


async def delete_task(session: AsyncSession, task_id: UUID, user_id: UUID) -> bool:
    task = await get_task(session, task_id, user_id)
    if task is None:
        return False
    await session.delete(task)
    await session.flush()
    return True


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

    q_lower = (query or "").lower().strip()
    if not q_lower:
        return []

    try:
        # pg_trgm path: rank by the greater of title/description similarity.
        stmt = (
            select(
                Task,
                func.greatest(
                    func.similarity(func.lower(Task.title), q_lower),
                    func.similarity(func.lower(func.coalesce(Task.description, "")), q_lower),
                ).label("rank"),
            )
            .where(
                Task.user_id == user_id,
                or_(
                    func.lower(Task.title) % q_lower,
                    func.lower(func.coalesce(Task.description, "")) % q_lower,
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
                Task.user_id == user_id,
                or_(
                    Task.title.ilike(func.concat('%', query, '%')),
                    Task.description.ilike(func.concat('%', query, '%')),
                ),
            )
            .limit(limit)
        )
        result = await session.execute(stmt)
        ranked = [(t, 0.0) for t in result.scalars().all()]

    # Sort by rank descending (best match first) for the fallback path too.
    ranked.sort(key=lambda r: r[1], reverse=True)
    return ranked
