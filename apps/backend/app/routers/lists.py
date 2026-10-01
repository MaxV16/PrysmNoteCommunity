from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.task_list import TaskList
from app.services import task_service
from app.utils.cache import cache_delete, cache_get, cache_set, user_cache_key
from app.utils.uuid_helpers import parse_uuid

router = APIRouter(prefix="/api/lists", tags=["lists"])

LISTS_CACHE_TTL = 30


def _require_uuid(value: str | UUID) -> UUID:
    parsed = parse_uuid(str(value))
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed


def _serialize(lst: TaskList) -> dict:
    return {
        "id": str(lst.id),
        "name": lst.name,
        "position": lst.position,
        "created_at": lst.created_at.isoformat() if lst.created_at else None,
        "updated_at": lst.updated_at.isoformat() if lst.updated_at else None,
    }


async def _get_list(session: AsyncSession, list_id: UUID, user_id: UUID) -> TaskList | None:
    result = await session.execute(
        select(TaskList).where(TaskList.id == list_id, TaskList.user_id == user_id)
    )
    return result.scalar_one_or_none()


class CreateListRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        if len(v) > 200:
            raise ValueError("Name must be at most 200 characters")
        return v


class UpdateListRequest(BaseModel):
    name: str | None = None
    position: int | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Name must not be empty")
            if len(v) > 200:
                raise ValueError("Name must be at most 200 characters")
        return v


@router.get("/")
async def list_lists(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    # Ensure every user has their default "My Tasks" list even before any task
    # is created, so the sidebar always has somewhere to put new tasks.
    await task_service.default_list_id(session, user.id)
    key = user_cache_key("lists", user.id)
    cached = await cache_get(key)
    if cached is not None:
        return cached
    result = await session.execute(
        select(TaskList)
        .where(TaskList.user_id == user.id)
        .order_by(TaskList.position, TaskList.created_at)
    )
    lists = result.scalars().all()
    payload = [_serialize(lst) for lst in lists]
    await cache_set(key, payload, LISTS_CACHE_TTL)
    return payload


@router.post("/")
async def create_list(
    request: CreateListRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    # Defend against unbounded list counts so a single user cannot row-bomb.
    count = (
        await session.execute(
            select(func.count(TaskList.id)).where(TaskList.user_id == user.id)
        )
    ).scalar() or 0
    if count >= 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="List limit reached (200)",
        )
    max_pos = (
        await session.execute(
            select(TaskList.position)
            .where(TaskList.user_id == user.id)
            .order_by(TaskList.position.desc())
            .limit(1)
        )
    ).scalar()
    lst = TaskList(
        user_id=user.id,
        name=request.name,
        position=(max_pos or 0) + 1,
    )
    session.add(lst)
    await session.flush()
    await session.refresh(lst)
    await cache_delete(user_cache_key("lists", user.id))
    return _serialize(lst)


@router.patch("/{list_id}")
async def update_list(
    list_id: str,
    request: UpdateListRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    lst = await _get_list(session, _require_uuid(list_id), user.id)
    if lst is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")
    # Renaming the default list would make it a normal list (and silently spawn a
    # fresh "My Tasks"), which is also the easy bypass for its delete guard.
    if request.name is not None and task_service.is_default_list_name(lst.name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The default \"My Tasks\" list cannot be renamed",
        )
    if request.name is not None:
        lst.name = request.name
    if request.position is not None:
        lst.position = request.position
    await session.flush()
    await session.refresh(lst)
    await cache_delete(user_cache_key("lists", user.id))
    return _serialize(lst)


@router.delete("/{list_id}")
async def delete_list(
    list_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    lst = await _get_list(session, _require_uuid(list_id), user.id)
    if lst is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    # "My Tasks" is the reassignment target for every other deleted list and the
    # fallback home for new tasks, so it must never be removable.
    if task_service.is_default_list_name(lst.name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The default \"My Tasks\" list cannot be deleted",
        )

    # Tasks of the deleted list move back to the user's default "My Tasks" list
    # before the list row goes away (ON DELETE SET NULL is only the fallback).
    default_id = await task_service.default_list_id(session, user.id)
    from app.models.task import Task
    from sqlalchemy import update as sa_update

    await session.execute(
        sa_update(Task)
        .where(Task.list_id == lst.id, Task.user_id == user.id)
        .values(list_id=default_id)
    )
    await session.delete(lst)
    await session.flush()
    await cache_delete(user_cache_key("lists", user.id))
    return {"status": "deleted"}