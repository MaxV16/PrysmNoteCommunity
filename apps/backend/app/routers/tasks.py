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
from app.services import subtask_service

VALID_STATUSES = {s.value for s in TaskStatus}

from datetime import date as date_type
from app.models.task_tag import TaskTag
from app.models.tag import Tag


def _parse_date_arg(value: str | None) -> date_type | None:
    """Parse an ISO-format date string into a date object.

    The models' start_date/due_date are `date` columns; passing raw strings to
    comparisons against them makes asyncpg fail with "operator does not exist:
    date >= character varying". ALWAYS coerce to a `date` first.
    """
    if value is None:
        return None
    try:
        return date_type.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def _serialize_task(task: Task) -> dict:
    return {
        "id": str(task.id),
        "user_id": str(task.user_id),
        "project_id": str(task.project_id) if task.project_id else None,
        "parent_task_id": str(task.parent_task_id) if task.parent_task_id else None,
        "title": task.title,
        "description": task.description,
        "status": task.status.value,
        "priority": task.priority,
        "start_date": task.start_date.isoformat() if task.start_date else None,
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "is_all_day": task.is_all_day,
        "estimated_minutes": task.estimated_minutes,
        "recurrence_rule": task.recurrence_rule,
        "recurrence_end_date": task.recurrence_end_date.isoformat() if task.recurrence_end_date else None,
        "sort_order": task.sort_order,
        "is_archived": task.is_archived,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }


router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class CreateTaskRequest(BaseModel):
    title: str
    project_id: str | None = None
    project_name: str | None = None
    parent_task_id: str | None = None
    description: str | None = None
    status: str = "backlog"
    priority: int = 3
    start_date: str | None = None
    due_date: str | None = None
    recurrence_rule: str | None = None
    estimated_minutes: int | None = None
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
    tag_ids: list[str] | None = None

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
        select(Task).where(Task.user_id == user.id).order_by(Task.created_at.desc()).offset(offset).limit(limit)
    )
    return [_serialize_task(t) for t in result.scalars().all()]


@router.post("/")
async def create_task_route(
    request: CreateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    project_id = None

    if request.project_name:
        from app.models.project import Project
        proj_result = await session.execute(
            select(Project).where(Project.user_id == user.id, Project.name == request.project_name)
        )
        proj = proj_result.scalar_one_or_none()
        if proj:
            project_id = proj.id
        else:
            proj = Project(user_id=user.id, name=request.project_name)
            session.add(proj)
            await session.flush()
            project_id = proj.id
    elif request.project_id:
        project_id = UUID(request.project_id)

    task = await create_task(
        session,
        user_id=user.id,
        title=request.title,
        project_id=project_id,
        parent_task_id=UUID(request.parent_task_id) if request.parent_task_id else None,
        description=request.description,
        status=request.status,
        priority=request.priority,
        start_date=request.start_date,
        due_date=request.due_date,
        recurrence_rule=request.recurrence_rule,
    )

    if request.estimated_minutes is not None:
        task.estimated_minutes = request.estimated_minutes

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

    await session.refresh(task)
    return _serialize_task(task)


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

    if request.tag_ids is not None:
        from app.models.task_tag import TaskTag
        existing_tags = await session.execute(
            select(TaskTag).where(TaskTag.task_id == task.id)
        )
        for et in existing_tags.scalars().all():
            await session.delete(et)
        for tag_id in request.tag_ids:
            session.add(TaskTag(task_id=task.id, tag_id=UUID(tag_id)))
        await session.flush()

    await session.refresh(task)
    return _serialize_task(task)


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
    if str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")

    subtask = Task(
        user_id=user.id,
        parent_task_id=UUID(task_id),
        title=request.title,
        description=request.description,
        status=TaskStatus.TODO,
        sort_order=await subtask_service.next_sort_order(session, UUID(task_id)),
    )
    session.add(subtask)
    await session.flush()

    await session.refresh(subtask)
    return {"id": str(subtask.id), "title": subtask.title, "status": subtask.status.value}


@router.post("/{task_id}/subtasks/reorder")
async def reorder_subtasks(
    task_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    parent = await get_task(session, UUID(task_id))
    if not parent or str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")
    ordered_ids = [str(i) for i in (body.get("ordered_ids") or [])]
    result = await subtask_service.reorder_subtasks(session, parent, ordered_ids)
    return {"status": "ok", "subtasks": result}


@router.post("/{task_id}/description-to-subtasks")
async def description_to_subtasks(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    parent = await get_task(session, UUID(task_id))
    if not parent or str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    created = await subtask_service.convert_description_to_subtasks(session, parent)
    return {
        "status": "ok",
        "description": parent.description,
        "subtasks": [
            {"id": str(t.id), "title": t.title, "status": t.status.value} for t in created
        ],
    }


@router.post("/{task_id}/subtasks-to-description")
async def subtasks_to_description(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    parent = await get_task(session, UUID(task_id))
    if not parent or str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    description = await subtask_service.convert_subtasks_to_description(session, parent)
    return {"status": "ok", "description": description}


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
@router.get("/search")
async def search_tasks_route(
    q: str,
    date_from: str | None = None,
    date_to: str | None = None,
    priority_min: int | None = None,
    priority_max: int | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from app.models.task import Task
    from sqlalchemy import or_

    stmt = select(Task).where(
        Task.user_id == user.id,
        or_(
            Task.title.ilike(f"%{q}%"),
            Task.description.ilike(f"%{q}%"),
        ),
    )

    if date_from:
        stmt = stmt.where(Task.start_date >= _parse_date_arg(date_from))
    if date_to:
        stmt = stmt.where(Task.start_date <= _parse_date_arg(date_to))
    if priority_min is not None:
        stmt = stmt.where(Task.priority >= priority_min)
    if priority_max is not None:
        stmt = stmt.where(Task.priority <= priority_max)

    stmt = stmt.limit(20)
    result = await session.execute(stmt)
    tasks = result.scalars().all()

    return [
        {
            "id": str(t.id),
            "title": t.title,
            "status": t.status.value if t.status else None,
            "priority": t.priority,
            "start_date": str(t.start_date) if t.start_date else None,
            "due_date": str(t.due_date) if t.due_date else None,
        }
        for t in tasks
    ]


@router.get("/date-range")
async def list_tasks_by_date_range(
    date_from: str,
    date_to: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import or_

    from_date = _parse_date_arg(date_from)
    to_date = _parse_date_arg(date_to)

    result = await session.execute(
        select(Task)
        .where(
            Task.user_id == user.id,
            Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
            or_(
                (Task.start_date >= from_date) & (Task.start_date <= to_date),
                (Task.due_date >= from_date) & (Task.due_date <= to_date),
                (Task.start_date <= from_date) & (Task.due_date >= to_date),
            ),
        )
        .order_by(Task.start_date)
    )
    tasks = result.scalars().all()

    return [
        {
            "id": str(t.id),
            "title": t.title,
            "status": t.status.value if t.status else None,
            "priority": t.priority,
            "start_date": str(t.start_date) if t.start_date else None,
            "due_date": str(t.due_date) if t.due_date else None,
            "project_id": str(t.project_id) if t.project_id else None,
        }
        for t in tasks
    ]


@router.get("/upcoming-deadlines")
async def get_upcoming_deadlines(
    days_ahead: int = 7,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from datetime import date, timedelta

    today = date.today()
    end = today + timedelta(days=days_ahead)

    result = await session.execute(
        select(Task)
        .where(
            Task.user_id == user.id,
            Task.due_date.isnot(None),
            Task.due_date >= today,
            Task.due_date <= end,
            Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
        )
        .order_by(Task.due_date, Task.priority.desc())
    )
    tasks = result.scalars().all()

    return [
        {
            "id": str(t.id),
            "title": t.title,
            "status": t.status.value if t.status else None,
            "priority": t.priority,
            "due_date": str(t.due_date),
            "start_date": str(t.start_date) if t.start_date else None,
        }
        for t in tasks
    ]


class BatchCreateRequest(BaseModel):
    tasks: list[dict]


@router.post("/batch")
async def batch_create_tasks(
    request: BatchCreateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    created = []
    for t_data in request.tasks:
        task = await create_task(
            session,
            user_id=user.id,
            title=t_data.get("title", "Untitled"),
            start_date=t_data.get("start_date"),
            due_date=t_data.get("due_date"),
            priority=t_data.get("priority", 2),
        )
        created.append({"id": str(task.id), "title": task.title})

    return {"created": len(created), "tasks": created}


@router.post("/expand-recurring")
async def expand_recurring(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from app.services.recurring_task_service import expand_recurring_tasks
    created = await expand_recurring_tasks(session, user.id)
    return {"expanded": created}


# Dynamic task routes are declared last so literal static paths like
# /search, /date-range and /upcoming-deadlines match first.
@router.get("/{task_id}")
async def get_task_route(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, UUID(task_id))
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return _serialize_task(task)
