from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus

BULLET_PREFIXES = ("- ", "* ", "+ ", "• ", "-", "*")


def _split_bullets(description: str) -> list[str]:
    """Split a description into lines of subtask content.

    Handles markdown bullet lists as well as plain newline-separated items.
    """
    lines = []
    for raw in description.splitlines():
        line = raw.strip()
        if not line:
            continue
        for prefix in BULLET_PREFIXES:
            if line.startswith(prefix):
                line = line[len(prefix):].strip()
                break
        if line:
            lines.append(line)
    return lines


async def convert_description_to_subtasks(
    session: AsyncSession, parent: Task
) -> list[Task]:
    """Split a parent task's description into child tasks and clear the description."""
    items = _split_bullets(parent.description or "")
    created: list[Task] = []
    if not items:
        parent.description = None
        await session.flush()
        return created

    for rank, title in enumerate(items):
        child = Task(
            user_id=parent.user_id,
            parent_task_id=parent.id,
            title=title[:500],
            status=TaskStatus.TODO,
            priority=parent.priority,
            sort_order=rank,
        )
        session.add(child)
        created.append(child)

    parent.description = None
    await session.flush()
    return created


async def convert_subtasks_to_description(
    session: AsyncSession, parent: Task
) -> str | None:
    """Collapse a parent task's child tasks back into a markdown description."""
    result = await session.execute(
        select(Task)
        .where(Task.parent_task_id == parent.id)
        .order_by(Task.sort_order, Task.created_at)
    )
    children = list(result.scalars().all())
    if not children:
        return None

    lines = [f"- {child.title}" for child in children]
    description = "\n".join(lines)
    for child in children:
        await session.delete(child)
    parent.description = description
    await session.flush()
    return description


async def reorder_subtasks(
    session: AsyncSession, parent: Task, ordered_ids: list[str]
) -> list[dict]:
    """Persist the given child-task ordering using sort_order."""
    result = await session.execute(
        select(Task).where(Task.parent_task_id == parent.id)
    )
    children = {str(t.id): t for t in result.scalars().all()}

    ordered: list[dict] = []
    for rank, task_id in enumerate(ordered_ids):
        child = children.get(task_id)
        if child is None:
            continue
        child.sort_order = rank
        ordered.append({"id": str(child.id), "sort_order": rank})

    await session.flush()
    return ordered


async def next_sort_order(session: AsyncSession, parent_id: UUID) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(Task.sort_order), -1)).where(
            Task.parent_task_id == parent_id
        )
    )
    return int(result.scalar_one()) + 1
