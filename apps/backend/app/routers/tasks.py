from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.embedding_service import generate_and_store_embedding
from app.services.task_service import create_task, delete_task, get_task, search_tasks, update_task

VALID_STATUSES = {s.value for s in TaskStatus}

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class CreateTaskRequest(BaseModel):
    title: str
    project_id: str | None = None
    parent_task_id: str | None = None
    description: str | None = None
    status: str = "backlog"
    priority: int = 3
    start_date: str | None = None
    due_date: str | None = None
    tag_ids: list[str] | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Title is required")
        if len(v) > 500:
            raise ValueError("Title must be at most 500 characters")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 10000:
            raise ValueError("Description must be at most 10,000 characters")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in VALID_STATUSES:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}")
        return v

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: int) -> int:
        if v < 1 or v > 5:
            raise ValueError("Priority must be between 1 and 5")
        return v

    @field_validator("start_date", "due_date")
    @classmethod
    def validate_date(cls, v: str | None) -> str | None:
        if v is not None:
            import re
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                raise ValueError("Date must be in YYYY-MM-DD format")
        return v


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: int | None = None
    start_date: str | None = None
    due_date: str | None = None
    is_all_day: bool | None = None
    estimated_minutes: int | None = None
    recurrence_rule: str | None = None
    recurrence_end_date: str | None = None
    sort_order: int | None = None
    project_id: str | None = None
    parent_task_id: str | None = None
    is_archived: bool | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Title must not be empty")
            if len(v) > 500:
                raise ValueError("Title must be at most 500 characters")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_STATUSES:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}")
        return v

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: int | None) -> int | None:
        if v is not None and (v < 1 or v > 5):
            raise ValueError("Priority must be between 1 and 5")
        return v

    @field_validator("start_date", "due_date", "recurrence_end_date")
    @classmethod
    def validate_date(cls, v: str | None) -> str | None:
        if v is not None:
            import re
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                raise ValueError("Date must be in YYYY-MM-DD format")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 10000:
            raise ValueError("Description must be at most 10,000 characters")
        return v

    def to_fields_dict(self) -> dict:
        return {k: v for k, v in self.model_dump(exclude_none=True).items()}


class CreateSubtaskRequest(BaseModel):
    title: str
    description: str | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Title is required")
        if len(v) > 500:
            raise ValueError("Title must be at most 500 characters")
        return v


@router.get("/")
async def list_tasks(
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if query:
        return await search_tasks(session, user.id, query)
    result = await session.execute(
        select(Task).where(Task.user_id == user.id).offset(offset).limit(limit)
    )
    return [{"id": str(t.id), "title": t.title, "status": t.status.value} for t in result.scalars().all()]


@router.get("/{task_id}")
async def get_task_route(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, UUID(task_id))
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


@router.post("/")
async def create_task_route(
    request: CreateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await create_task(
        session,
        user_id=user.id,
        title=request.title,
        project_id=UUID(request.project_id) if request.project_id else None,
        parent_task_id=UUID(request.parent_task_id) if request.parent_task_id else None,
        description=request.description,
        status=request.status,
        priority=request.priority,
        start_date=request.start_date,
        due_date=request.due_date,
    )

    if request.tag_ids:
        from app.models.task_tag import TaskTag
        for tag_id in request.tag_ids:
            tag_uuid = UUID(tag_id)
            existing = await session.execute(
                select(TaskTag).where(TaskTag.task_id == task.id, TaskTag.tag_id == tag_uuid)
            )
            if not existing.scalar_one_or_none():
                session.add(TaskTag(task_id=task.id, tag_id=tag_uuid))
        await session.flush()

    await generate_and_store_embedding(
        session, task.id, user.id, task.title, task.description
    )

    return {"id": str(task.id), "title": task.title, "status": task.status.value}


@router.patch("/{task_id}")
async def update_task_route(
    task_id: str,
    request: UpdateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    fields = request.to_fields_dict()
    task = await update_task(session, UUID(task_id), fields)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    if "title" in fields or "description" in fields:
        await generate_and_store_embedding(
            session, task.id, user.id, task.title, task.description
        )

    return {"id": str(task.id), "title": task.title, "status": task.status.value}


@router.delete("/{task_id}")
async def delete_task_route(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    deleted = await delete_task(session, UUID(task_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return {"status": "deleted"}


@router.get("/{task_id}/subtasks")
async def list_subtasks(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, UUID(task_id))
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    result = await session.execute(
        select(Task).where(Task.parent_task_id == UUID(task_id), Task.user_id == user.id)
    )
    return [
        {"id": str(t.id), "title": t.title, "status": t.status.value, "priority": t.priority}
        for t in result.scalars().all()
    ]


@router.post("/{task_id}/subtasks")
async def create_subtask(
    task_id: str,
    request: CreateSubtaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    parent = await get_task(session, UUID(task_id))
    if not parent:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")

    subtask = Task(
        user_id=user.id,
        parent_task_id=UUID(task_id),
        title=request.title,
        description=request.description,
        status="todo",
    )
    session.add(subtask)
    await session.flush()

    return {"id": str(subtask.id), "title": subtask.title, "status": subtask.status.value}


@router.patch("/{task_id}/subtasks/{subtask_id}")
async def update_subtask(
    task_id: str,
    subtask_id: str,
    request: UpdateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    subtask = await get_task(session, UUID(subtask_id))
    if not subtask or str(subtask.parent_task_id) != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subtask not found")
    updated = await update_task(session, UUID(subtask_id), request.to_fields_dict())
    return {"id": str(updated.id), "title": updated.title, "status": updated.status.value}
@router.post("/expand-recurring")
async def expand_recurring(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from app.services.recurring_task_service import expand_recurring_tasks
    created = await expand_recurring_tasks(session, user.id)
    return {"expanded": created}
