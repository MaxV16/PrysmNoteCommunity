from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.user_preference import UserPreference

router = APIRouter(prefix="/api/preferences", tags=["preferences"])

MAX_KEY_LENGTH = 64


class PreferenceUpdate(BaseModel):
    value: Any


def _serialize(pref: UserPreference) -> dict:
    return {"key": pref.key, "value": pref.value}


@router.get("/")
async def list_preferences(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(UserPreference).where(UserPreference.user_id == user.id)
    )
    return {p.key: p.value for p in result.scalars().all()}


@router.put("/{key}")
async def upsert_preference(
    key: str,
    request: PreferenceUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if not key or len(key) > MAX_KEY_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Key must be at most {MAX_KEY_LENGTH} characters",
        )
    result = await session.execute(
        select(UserPreference).where(
            UserPreference.user_id == user.id, UserPreference.key == key
        )
    )
    pref = result.scalar_one_or_none()
    if pref is None:
        pref = UserPreference(user_id=user.id, key=key, value=request.value)
        session.add(pref)
    else:
        pref.value = request.value
    await session.flush()
    await session.refresh(pref)
    return _serialize(pref)


@router.delete("/{key}")
async def delete_preference(
    key: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(UserPreference).where(
            UserPreference.user_id == user.id, UserPreference.key == key
        )
    )
    pref = result.scalar_one_or_none()
    if pref is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preference not found")
    await session.delete(pref)
    await session.flush()
    return {"status": "deleted"}
