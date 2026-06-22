from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.tag import Tag
from app.models.task import Task
from app.models.task_tag import TaskTag
from app.models.user import User

router = APIRouter(prefix="/api/tags", tags=["tags"])


class CreateTagRequest(BaseModel):
    name: str
    color: str | None = None


@router.get("/")
async def list_tags(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Tag).where(Tag.user_id == user.id)
    )
    return [
        {"id": str(t.id), "name": t.name, "color": t.color}
        for t in result.scalars().all()
    ]


@router.post("/")
async def create_tag_route(
    request: CreateTagRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    tag = Tag(user_id=user.id, name=request.name, color=request.color)
    session.add(tag)
    await session.flush()
    return {"id": str(tag.id), "name": tag.name, "color": tag.color}


@router.delete("/{tag_id}")
async def delete_tag_route(
    tag_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Tag).where(Tag.id == tag_id, Tag.user_id == user.id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")
    await session.delete(tag)
    await session.flush()
    return {"status": "deleted"}


@router.post("/tasks/{task_id}")
async def assign_tag_to_task(
    task_id: str,
    tag_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_result = await session.execute(
        select(Task).where(Task.id == UUID(task_id), Task.user_id == user.id)
    )
    task = task_result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    tag_result = await session.execute(
        select(Tag).where(Tag.id == UUID(tag_id), Tag.user_id == user.id)
    )
    tag = tag_result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")

    existing = await session.execute(
        select(TaskTag).where(TaskTag.task_id == UUID(task_id), TaskTag.tag_id == UUID(tag_id))
    )
    if existing.scalar_one_or_none():
        return {"status": "already_assigned"}

    task_tag = TaskTag(task_id=UUID(task_id), tag_id=UUID(tag_id))
    session.add(task_tag)
    await session.flush()
    return {"status": "assigned"}


@router.delete("/tasks/{task_id}")
async def remove_tag_from_task(
    task_id: str,
    tag_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(TaskTag).where(
            TaskTag.task_id == UUID(task_id),
            TaskTag.tag_id == UUID(tag_id),
        )
    )
    task_tag = result.scalar_one_or_none()
    if not task_tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not assigned to task")
    await session.delete(task_tag)
    await session.flush()
    return {"status": "removed"}


@router.get("/tasks/{task_id}")
async def get_task_tags(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_result = await session.execute(
        select(Task).where(Task.id == UUID(task_id), Task.user_id == user.id)
    )
    if not task_result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    result = await session.execute(
        select(Tag).join(TaskTag).where(TaskTag.task_id == UUID(task_id))
    )
    return [
        {"id": str(t.id), "name": t.name, "color": t.color}
        for t in result.scalars().all()
    ]
