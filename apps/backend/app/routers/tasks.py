from uuid import UUID

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory, get_db
from app.dependencies import get_current_user
from app.models.task import Task, TaskStatus
from app.models.board_section import BoardSection
from app.models.user import User
from app.services.embedding_service import generate_and_store_embedding
from app.services.task_service import create_task, delete_task, get_task, search_tasks, update_task, task_access_condition, delete_tasks_batch, reschedule_tasks_batch, move_tasks_to_section, set_task_dates_batch
from app.services import subtask_service
from app.models.teams import TaskShare
from app.utils.uuid_helpers import parse_uuid

VALID_STATUSES = {s.value for s in TaskStatus}


def _require_uuid(value: str) -> UUID:
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed

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


def _serialize_task(task: Task, tags: list[dict] | None = None) -> dict:
    return {
        "id": str(task.id),
        "user_id": str(task.user_id),
        "parent_task_id": str(task.parent_task_id) if task.parent_task_id else None,
        "board_section_id": str(task.board_section_id) if task.board_section_id else None,
        "board_order": task.board_order,
        "title": task.title,
        "description": task.description,
        "status": task.status.value,
        "priority": task.priority,
        "start_date": task.start_date.isoformat() if task.start_date else None,
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "start_time": task.start_time.strftime("%H:%M") if task.start_time else None,
        "end_time": task.end_time.strftime("%H:%M") if task.end_time else None,
        "is_all_day": task.is_all_day,
        "estimated_minutes": task.estimated_minutes,
        "recurrence_rule": task.recurrence_rule,
        "recurrence_end_date": task.recurrence_end_date.isoformat() if task.recurrence_end_date else None,
        "sort_order": task.sort_order,
        "is_archived": task.is_archived,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
        "tags": tags or [],
    }


async def _tags_by_task(
    session: AsyncSession, task_ids: list[UUID]
) -> dict[str, list[dict]]:
    """Load Tag rows for many tasks in ONE query, grouped by task id.

    Returns ``{task_id: [{"id", "name", "color"}, ...]}`` so serializers can
    attach tags to a batch of tasks without an N+1 query per task.
    """
    if not task_ids:
        return {}
    result = await session.execute(
        select(TaskTag.tag_id, TaskTag.task_id, Tag.name, Tag.color)
        .join(Tag, Tag.id == TaskTag.tag_id)
        .where(TaskTag.task_id.in_(task_ids))
    )
    grouped: dict[str, list[dict]] = {}
    for tag_id, task_id, name, color in result.all():
        grouped.setdefault(str(task_id), []).append(
            {"id": str(tag_id), "name": name, "color": color}
        )
    return grouped


async def serialize_tasks(session: AsyncSession, tasks: list[Task]) -> list[dict]:
    """Serialize a batch of tasks with their tags attached (one tags query)."""
    tags_by_task = await _tags_by_task(session, [t.id for t in tasks])
    return [_serialize_task(t, tags_by_task.get(str(t.id), [])) for t in tasks]


router = APIRouter(prefix="/api/tasks", tags=["tasks"])


async def _embed_task_background(
    task_id: UUID,
    user_id: UUID,
    title: str,
    description: str | None,
) -> None:
    """Generate + store a task embedding off the request path (fire-and-forget).

    The request session commits its task row only at get_db teardown, so a fresh
    session may not see the row yet; retry briefly before giving up. All
    exceptions are swallowed - embedding loss is non-critical and must never
    affect the create/update response.
    """
    from app.utils.rls import set_rls_user_id

    for attempt in range(3):
        try:
            async with async_session_factory() as session:
                if session.get_bind().dialect.name == "postgresql":
                    await set_rls_user_id(session, user_id)
                if await session.get(Task, task_id) is None:
                    if attempt < 2:
                        await asyncio.sleep(0.5)
                        continue
                    return
                await generate_and_store_embedding(session, task_id, user_id, title, description)
                await session.commit()
                return
        except Exception:
            if attempt < 2:
                await asyncio.sleep(0.5)
    return


class CreateTaskRequest(BaseModel):
    title: str
    parent_task_id: str | None = None
    board_section_id: str | None = None
    description: str | None = None
    status: str = "backlog"
    priority: int = 3
    start_date: str | None = None
    due_date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    recurrence_rule: str | None = None
    recurrence_end_date: str | None = None
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

    @field_validator("start_date", "due_date", "recurrence_end_date")
    @classmethod
    def validate_date(cls, v: str | None) -> str | None:
        if v is not None:
            import re
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                raise ValueError("Date must be in YYYY-MM-DD format")
        return v

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time(cls, v: str | None) -> str | None:
        if v is not None:
            import re
            if not re.match(r"^\d{2}:\d{2}$", v):
                raise ValueError("Time must be in HH:MM format")
        return v


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: int | None = None
    start_date: str | None = None
    due_date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    is_all_day: bool | None = None
    estimated_minutes: int | None = None
    recurrence_rule: str | None = None
    recurrence_end_date: str | None = None
    sort_order: int | None = None
    parent_task_id: str | None = None
    is_archived: bool | None = None
    tag_ids: list[str] | None = None
    board_section_id: str | None = None
    board_order: int | None = None

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

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time(cls, v: str | None) -> str | None:
        if v is not None:
            import re
            if not re.match(r"^\d{2}:\d{2}$", v):
                raise ValueError("Time must be in HH:MM format")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 10000:
            raise ValueError("Description must be at most 10,000 characters")
        return v

    def to_fields_dict(self) -> dict:
        # start_time/end_time are ALWAYS sent (even null) so a caller can clear
        # a slot; the rest nulls are treated as "not provided".
        data = self.model_dump(exclude_none=True)
        for key in ("start_time", "end_time"):
            value = getattr(self, key)
            if value is None:
                data[key] = None
        return data


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


@router.get("/{task_id}/shares")
async def get_task_shares(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, _require_uuid(task_id), user.id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    result = await session.execute(select(TaskShare).where(TaskShare.task_id == task.id))
    return {"team_ids": [str(s.team_id) for s in result.scalars().all()]}


@router.get("/")
async def list_tasks(
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
    date_from: str | None = None,
    date_to: str | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    limit = min(max(limit, 1), 200)
    offset = max(offset, 0)
    if query:
        results = await search_tasks(session, user.id, query)
        return await serialize_tasks(session, [t for t, _rank in results])

    from sqlalchemy import or_

    # Range mode: lazily expand recurring templates into the window, then return
    # the fully serialized tasks overlapping it (tags + board fields needed by
    # kanban/board). When only one bound is given, treat the window as that
    # single day.
    if date_from is not None or date_to is not None:
        from app.services.recurring_task_service import expand_recurring_for_range

        from_date = _parse_date_arg(date_from) or _parse_date_arg(date_to)
        to_date = _parse_date_arg(date_to) or _parse_date_arg(date_from)
        if from_date is None or to_date is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from and date_to must be valid YYYY-MM-DD dates",
            )
        if to_date < from_date:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_to must not be before date_from",
            )

        # Flush newly created occurrences before the read below sees them.
        await expand_recurring_for_range(session, user.id, from_date, to_date)

        result = await session.execute(
            select(Task)
            .where(
                task_access_condition(user.id),
                or_(
                    (Task.start_date >= from_date) & (Task.start_date <= to_date),
                    (Task.due_date >= from_date) & (Task.due_date <= to_date),
                    (Task.start_date <= from_date) & (Task.due_date >= to_date),
                ),
            )
            .order_by(Task.start_date)
        )
        return await serialize_tasks(session, result.scalars().all())

    result = await session.execute(
        select(Task).where(task_access_condition(user.id)).order_by(Task.created_at.desc()).offset(offset).limit(limit)
    )
    return await serialize_tasks(session, result.scalars().all())


@router.post("/")
async def create_task_route(
    request: CreateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    # Authorization: a task's parent must belong to the caller, otherwise a user
    # could link a task under another user's task.
    if request.parent_task_id:
        parent = await get_task(session, _require_uuid(request.parent_task_id), user.id)
        if not parent:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")

    # Same ownership rule for board sections: creating a card pinned to someone
    # else's section would leak its id into our task row.
    board_section_uuid = None
    if request.board_section_id:
        result = await session.execute(
            select(BoardSection.id).where(
                BoardSection.id == _require_uuid(request.board_section_id),
                BoardSection.user_id == user.id,
            )
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board section not found")
        board_section_uuid = _require_uuid(request.board_section_id)

    task = await create_task(
        session,
        user_id=user.id,
        title=request.title,
        parent_task_id=_require_uuid(request.parent_task_id) if request.parent_task_id else None,
        board_section_id=board_section_uuid,
        description=request.description,
        status=request.status,
        priority=request.priority,
        start_date=request.start_date,
        due_date=request.due_date,
        start_time=request.start_time,
        end_time=request.end_time,
        recurrence_rule=request.recurrence_rule,
        recurrence_end_date=request.recurrence_end_date,
    )

    if request.estimated_minutes is not None:
        task.estimated_minutes = request.estimated_minutes

    if request.tag_ids:
        from app.models.task_tag import TaskTag
        from app.models.tag import Tag
        tag_uuids = [_require_uuid(tag_id) for tag_id in request.tag_ids]
        # One ownership query for the whole batch instead of one per tag.
        owned = await session.execute(
            select(Tag.id).where(Tag.id.in_(tag_uuids), Tag.user_id == user.id)
        )
        owned_ids = {row[0] for row in owned.all()}
        for tag_id, tag_uuid in zip(request.tag_ids, tag_uuids):
            if tag_uuid not in owned_ids:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Tag not found: {tag_id}")
        existing = await session.execute(
            select(TaskTag.tag_id).where(TaskTag.task_id == task.id, TaskTag.tag_id.in_(tag_uuids))
        )
        existing_ids = {row[0] for row in existing.all()}
        for tag_uuid in tag_uuids:
            if tag_uuid not in existing_ids:
                session.add(TaskTag(task_id=task.id, tag_id=tag_uuid))
        await session.flush()

    asyncio.create_task(
        _embed_task_background(task.id, user.id, task.title, task.description)
    )

    await session.refresh(task)
    return (await serialize_tasks(session, [task]))[0]


@router.patch("/{task_id}")
async def update_task_route(
    task_id: str,
    request: UpdateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    fields = request.to_fields_dict()
    task = await update_task(session, _require_uuid(task_id), fields, user.id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    # Authorization: the new parent (if any) must belong to the caller.
    if fields.get("parent_task_id"):
        parent = await get_task(session, _require_uuid(fields["parent_task_id"]), user.id)
        if not parent:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")

    if "title" in fields or "description" in fields:
        asyncio.create_task(
            _embed_task_background(task.id, user.id, task.title, task.description)
        )

    if request.tag_ids is not None:
        from app.models.task_tag import TaskTag
        from app.models.tag import Tag
        tag_uuids = [_require_uuid(tag_id) for tag_id in request.tag_ids]
        owned = await session.execute(
            select(Tag.id).where(Tag.id.in_(tag_uuids), Tag.user_id == user.id)
        )
        owned_ids = {row[0] for row in owned.all()}
        for tag_id, tag_uuid in zip(request.tag_ids, tag_uuids):
            if tag_uuid not in owned_ids:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Tag not found: {tag_id}")
        existing_tags = await session.execute(
            select(TaskTag).where(TaskTag.task_id == task.id)
        )
        for et in existing_tags.scalars().all():
            await session.delete(et)
        for tag_uuid in tag_uuids:
            session.add(TaskTag(task_id=task.id, tag_id=tag_uuid))
        await session.flush()

    await session.refresh(task)
    return (await serialize_tasks(session, [task]))[0]


@router.delete("/{task_id}")
async def delete_task_route(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    deleted = await delete_task(session, _require_uuid(task_id), user.id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return {"status": "deleted"}


@router.get("/{task_id}/subtasks")
async def list_subtasks(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, _require_uuid(task_id), user.id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    result = await session.execute(
        select(Task).where(Task.parent_task_id == _require_uuid(task_id)).where(task_access_condition(user.id))
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
    parent = await get_task(session, _require_uuid(task_id), user.id)
    if not parent:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")
    if str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent task not found")
    task_uuid = _require_uuid(task_id)

    subtask = Task(
        user_id=user.id,
        parent_task_id=task_uuid,
        title=request.title,
        description=request.description,
        status=TaskStatus.TODO,
        sort_order=await subtask_service.next_sort_order(session, task_uuid),
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
    parent = await get_task(session, _require_uuid(task_id), user.id)
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
    parent = await get_task(session, _require_uuid(task_id), user.id)
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
    parent = await get_task(session, _require_uuid(task_id), user.id)
    if not parent or str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    description = await subtask_service.convert_subtasks_to_description(session, parent)
    return {"status": "ok", "description": description}


@router.post("/{task_id}/breakdown")
async def breakdown_task(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Break a task down into subtasks and CREATE the child tasks.

    Uses the LLM when a key is configured; otherwise falls back to splitting
    the description bullets or a generic breakdown so the action always works.
    """
    parent = await get_task(session, _require_uuid(task_id), user.id)
    if not parent or str(parent.user_id) != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    client = None
    try:
        from app.routers.ai import get_user_api_key
        from app.services.ai_service import get_llm_client
        for provider in ("openai", "gemini", "deepseek"):
            api_key = await get_user_api_key(session, user, provider)
            if api_key:
                client = await get_llm_client(provider, api_key)
                break
    except Exception:
        client = None

    titles = await subtask_service.ai_breakdown_titles(session, parent, client)
    created = await subtask_service.create_subtask_titles(session, parent, titles)
    return {
        "status": "ok",
        "subtasks": [
            {"id": str(t.id), "title": t.title, "status": t.status.value} for t in created
        ],
    }


@router.patch("/{task_id}/subtasks/{subtask_id}")
async def update_subtask(
    task_id: str,
    subtask_id: str,
    request: UpdateTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    subtask = await get_task(session, _require_uuid(subtask_id), user.id)
    if not subtask or str(subtask.parent_task_id) != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subtask not found")
    updated = await update_task(session, _require_uuid(subtask_id), request.to_fields_dict(), user.id)
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
    from sqlalchemy import or_, func

    q_lower = q.lower().strip()
    rank_expr = func.greatest(
        func.similarity(func.lower(Task.title), q_lower),
        func.similarity(func.lower(func.coalesce(Task.description, "")), q_lower),
    ).label("rank")

    stmt = select(Task, rank_expr).where(
        task_access_condition(user.id),
        or_(
            func.lower(Task.title) % q_lower,
            func.lower(func.coalesce(Task.description, "")) % q_lower,
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

    stmt = stmt.order_by(rank_expr.desc()).limit(20)
    result = await session.execute(stmt)
    tasks = result.all()

    return [
        {
            "id": str(t.id),
            "title": t.title,
            "status": t.status.value if t.status else None,
            "priority": t.priority,
            "start_date": str(t.start_date) if t.start_date else None,
            "due_date": str(t.due_date) if t.due_date else None,
            "rank": round(rank, 3),
        }
        for t, rank in tasks
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
    if from_date is None or to_date is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_from and date_to must be valid YYYY-MM-DD dates",
        )
    if to_date < from_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_to must not be before date_from",
        )

    # Lazily materialize recurring occurrences into the window so AI-chat date
    # lookups expand endless templates on demand too. The reduced schema below is
    # not fed into the task store, so this is read-only from the store's view.
    from app.services.recurring_task_service import expand_recurring_for_range
    await expand_recurring_for_range(session, user.id, from_date, to_date)

    result = await session.execute(
        select(Task)
        .where(
            task_access_condition(user.id),
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
            task_access_condition(user.id),
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
    tasks: list[CreateTaskRequest]

    @field_validator("tasks")
    @classmethod
    def validate_batch_size(cls, v: list) -> list:
        # Prevent row-bombing: each item can itself expand into many recurring
        # occurrences, so the raw request size must be bounded.
        if not v:
            raise ValueError("Batch must contain at least one task")
        if len(v) > 50:
            raise ValueError("Batch must contain at most 50 tasks")
        return v


@router.post("/batch")
async def batch_create_tasks(
    request: BatchCreateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    created = []
    for task_req in request.tasks:
        task = await create_task(
            session,
            user_id=user.id,
            title=task_req.title,
            start_date=task_req.start_date,
            due_date=task_req.due_date,
            start_time=task_req.start_time,
            end_time=task_req.end_time,
            priority=task_req.priority,
            recurrence_rule=task_req.recurrence_rule,
            recurrence_end_date=task_req.recurrence_end_date,
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


class BoardMoveRequest(BaseModel):
    task_id: str
    section_id: str | None = None
    index: int = 0


@router.post("/board-move")
async def board_move_task(
    request: BoardMoveRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Atomically move a task into a board section (or the implicit "Unsorted"
    area when section_id is null) and splice it at `index` among that section's
    tasks, renumbering board_order 0..n-1 for the destination set."""
    task = await get_task(session, _require_uuid(request.task_id), user.id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    section = None
    if request.section_id:
        result = await session.execute(
            select(BoardSection).where(
                BoardSection.id == _require_uuid(request.section_id),
                BoardSection.user_id == user.id,
            )
        )
        section = result.scalar_one_or_none()
        if section is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

    await move_tasks_to_section(
        session,
        [task.id],
        user.id,
        section.id if section else None,
        section.status if section else None,
        request.index,
    )
    await session.refresh(task)
    return (await serialize_tasks(session, [task]))[0]


def validate_task_id_batch(v: list) -> list:
    # Bounded batch so a single request can never touch an unbounded task set.
    if not v:
        raise ValueError("Batch must contain at least one task id")
    if len(v) > 100:
        raise ValueError("Batch must contain at most 100 task ids")
    return v


class BatchRescheduleRequest(BaseModel):
    task_ids: list[str]
    delta_days: int

    @field_validator("task_ids")
    @classmethod
    def validate_task_ids(cls, v: list) -> list:
        return validate_task_id_batch(v)

    @field_validator("delta_days")
    @classmethod
    def validate_delta_days(cls, v: int) -> int:
        if v < -3650 or v > 3650:
            raise ValueError("delta_days must be between -3650 and 3650")
        return v


class BatchBoardMoveRequest(BaseModel):
    task_ids: list[str]
    section_id: str | None = None
    index: int = 0

    @field_validator("task_ids")
    @classmethod
    def validate_task_ids(cls, v: list) -> list:
        return validate_task_id_batch(v)


class BatchDeleteRequest(BaseModel):
    task_ids: list[str]

    @field_validator("task_ids")
    @classmethod
    def validate_task_ids(cls, v: list) -> list:
        return validate_task_id_batch(v)


class BatchSetDateRequest(BaseModel):
    task_ids: list[str]
    date: str

    @field_validator("task_ids")
    @classmethod
    def validate_task_ids(cls, v: list) -> list:
        return validate_task_id_batch(v)

    @field_validator("date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError("Date must be in YYYY-MM-DD format")
        return v


@router.post("/batch-reschedule")
async def batch_reschedule(
    request: BatchRescheduleRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_ids = [parse_uuid(uid) for uid in request.task_ids]
    if any(uid is None for uid in task_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    moved = await reschedule_tasks_batch(
        session,
        [uid for uid in task_ids if uid is not None],
        user.id,
        request.delta_days,
    )
    return {"rescheduled": moved}


@router.post("/batch-board-move")
async def batch_board_move(
    request: BatchBoardMoveRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_ids = [parse_uuid(uid) for uid in request.task_ids]
    if any(uid is None for uid in task_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")

    result = await session.execute(
        select(Task).where(task_access_condition(user.id), Task.id.in_([uid for uid in task_ids if uid is not None]))
    )
    owned_ids = {t.id for t in result.scalars().all()}
    for uid in task_ids:
        if uid is None:
            continue
        if uid not in owned_ids:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    section = None
    if request.section_id:
        result = await session.execute(
            select(BoardSection).where(
                BoardSection.id == _require_uuid(request.section_id),
                BoardSection.user_id == user.id,
            )
        )
        section = result.scalar_one_or_none()
        if section is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

    moved = await move_tasks_to_section(
        session,
        [uid for uid in task_ids if uid is not None],
        user.id,
        section.id if section else None,
        section.status if section else None,
        request.index,
    )
    return {"moved": moved}


@router.post("/batch-delete")
async def batch_delete(
    request: BatchDeleteRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_ids = [parse_uuid(uid) for uid in request.task_ids]
    if any(uid is None for uid in task_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    deleted = await delete_tasks_batch(
        session,
        [uid for uid in task_ids if uid is not None],
        user.id,
    )
    return {"deleted": deleted}


@router.post("/batch-set-date")
async def batch_set_date(
    request: BatchSetDateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task_ids = [parse_uuid(uid) for uid in request.task_ids]
    if any(uid is None for uid in task_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    parsed = _parse_date_arg(request.date)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid date")
    dated = await set_task_dates_batch(
        session,
        [uid for uid in task_ids if uid is not None],
        user.id,
        parsed,
    )
    return {"updated": dated}


# Dynamic task routes are declared last so literal static paths like
# /search, /date-range and /upcoming-deadlines match first.
@router.get("/{task_id}")
async def get_task_route(
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    task = await get_task(session, _require_uuid(task_id), user.id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return (await serialize_tasks(session, [task]))[0]
