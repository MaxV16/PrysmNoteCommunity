from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task


async def create_task(
    session: AsyncSession,
    user_id: UUID,
    title: str,
    project_id: UUID | None = None,
    parent_task_id: UUID | None = None,
    description: str | None = None,
    status: str = "backlog",
    priority: int = 3,
    start_date: str | None = None,
    due_date: str | None = None,
    recurrence_rule: str | None = None,
) -> Task:
    task = Task(
        user_id=user_id,
        project_id=project_id,
        parent_task_id=parent_task_id,
        title=title,
        description=description,
        status=status,
        priority=priority,
        start_date=start_date,
        due_date=due_date,
        recurrence_rule=recurrence_rule,
    )
    session.add(task)
    await session.flush()
    return task


async def get_task(session: AsyncSession, task_id: UUID) -> Task | None:
    result = await session.execute(select(Task).where(Task.id == task_id))
    return result.scalar_one_or_none()


ALLOWED_UPDATE_FIELDS = {
    "title", "description", "status", "priority",
    "start_date", "due_date", "is_all_day", "estimated_minutes",
    "recurrence_rule", "recurrence_end_date", "sort_order",
    "project_id", "parent_task_id", "is_archived",
}


async def update_task(session: AsyncSession, task_id: UUID, fields: dict) -> Task | None:
    task = await get_task(session, task_id)
    if task is None:
        return None
    for key, value in fields.items():
        if key in ALLOWED_UPDATE_FIELDS:
            setattr(task, key, value)
    await session.flush()
    return task


async def delete_task(session: AsyncSession, task_id: UUID) -> bool:
    task = await get_task(session, task_id)
    if task is None:
        return False
    await session.delete(task)
    await session.flush()
    return True


async def search_tasks(session: AsyncSession, user_id: UUID, query: str, limit: int = 20) -> list[Task]:
    from sqlalchemy import or_
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
    return list(result.scalars().all())
