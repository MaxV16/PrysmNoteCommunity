from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.task import Task
from app.models.task_link import TaskLink, TaskLinkType
from app.models.user import User

router = APIRouter(prefix="/api/task-links", tags=["task_links"])


class CreateTaskLinkRequest(BaseModel):
    source_task_id: str
    target_task_id: str
    link_type: str = "related"


@router.get("/")
async def list_links(
    task_id: str | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    stmt = select(TaskLink).where(TaskLink.user_id == user.id)
    if task_id:
        stmt = stmt.where(
            (TaskLink.source_task_id == UUID(task_id)) | (TaskLink.target_task_id == UUID(task_id))
        )
    result = await session.execute(stmt)
    return [
        {
            "id": str(l.id),
            "source_task_id": str(l.source_task_id),
            "target_task_id": str(l.target_task_id),
            "link_type": l.link_type.value,
            "created_at": str(l.created_at),
        }
        for l in result.scalars().all()
    ]


@router.post("/")
async def create_link_route(
    request: CreateTaskLinkRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    source = await session.execute(
        select(Task).where(Task.id == UUID(request.source_task_id), Task.user_id == user.id)
    )
    if not source.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source task not found")

    target = await session.execute(
        select(Task).where(Task.id == UUID(request.target_task_id), Task.user_id == user.id)
    )
    if not target.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target task not found")

    existing = await session.execute(
        select(TaskLink).where(
            TaskLink.user_id == user.id,
            TaskLink.source_task_id == UUID(request.source_task_id),
            TaskLink.target_task_id == UUID(request.target_task_id),
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Link already exists")

    link = TaskLink(
        user_id=user.id,
        source_task_id=UUID(request.source_task_id),
        target_task_id=UUID(request.target_task_id),
        link_type=TaskLinkType(request.link_type),
    )
    session.add(link)
    await session.flush()
    return {
        "id": str(link.id),
        "source_task_id": request.source_task_id,
        "target_task_id": request.target_task_id,
        "link_type": request.link_type,
    }


@router.delete("/{link_id}")
async def delete_link_route(
    link_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(TaskLink).where(TaskLink.id == UUID(link_id), TaskLink.user_id == user.id)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found")
    await session.delete(link)
    await session.flush()
    return {"status": "deleted"}
