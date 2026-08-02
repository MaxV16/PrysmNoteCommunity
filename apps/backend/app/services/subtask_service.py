from __future__ import annotations

import json
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


_GENERIC_BREAKDOWN = [
    "Define scope and requirements",
    "Plan the steps and timeline",
    "Execute the core work",
    "Review and test the result",
    "Finalize and deliver",
]


async def create_subtask_titles(
    session: AsyncSession,
    parent: Task,
    titles: list[str],
) -> list[Task]:
    """Persist the given subtask titles under a parent task, in order."""
    created: list[Task] = []
    for title in titles:
        cleaned = (title or "").strip()
        if not cleaned:
            continue
        child = Task(
            user_id=parent.user_id,
            parent_task_id=parent.id,
            title=cleaned[:500],
            status=TaskStatus.TODO,
            priority=parent.priority,
            sort_order=await next_sort_order(session, parent.id),
        )
        session.add(child)
        created.append(child)
    await session.flush()
    return created


async def ai_breakdown_titles(
    session: AsyncSession,
    parent: Task,
    client=None,
) -> list[str]:
    """Ask the LLM (if available) for breakdown subtask titles.

    Falls back to splitting the description bullets, then to a generic list.
    Never raises and always returns a non-empty list so the UI action always works.
    """
    titles: list[str] = []
    if client is not None:
        try:
            prompt = (
                "You are a task breakdown expert. Given the task, respond with EXACTLY a "
                "JSON array of 4-6 concrete, actionable subtask titles to complete it. "
                "Return nothing but the JSON array, e.g. "
                '["Research and define scope", "Create a plan", "Execute", "Review"].\n\n'
                f"Task title: {parent.title}\n"
                f"Task description: {parent.description or 'None'}"
            )
            response = await client.chat(
                [{"role": "user", "content": prompt}],
                tools=None,
                temperature=0.7,
                max_tokens=500,
            )
            content = response.get("choices", [{}])[0].get("message", {}).get("content", "")
            parsed = json.loads(content)
            if isinstance(parsed, list):
                titles = [str(t) for t in parsed if str(t).strip()]
            if not titles:
                for line in content.splitlines():
                    line = (line or "").strip().lstrip("-").strip().strip("\"'")
                    if line and len(line) > 3:
                        titles.append(line)
        except Exception:
            titles = []

    if not titles:
        titles = _split_bullets(parent.description or "")

    if not titles:
        titles = list(_GENERIC_BREAKDOWN)

    return titles[:6]
