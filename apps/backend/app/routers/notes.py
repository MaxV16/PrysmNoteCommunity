from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.note import Note
from app.models.user import User

router = APIRouter(prefix="/api/notes", tags=["notes"])


class NotePayload(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = ""
    content: str = ""
    color: str = "#fbbf24"
    x: float = 300
    y: float = 200
    width: float = 320
    height: float = 240
    minimized: bool = False
    open: bool = False
    sort: int = 0


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    minimized: Optional[bool] = None
    open: Optional[bool] = None
    sort: Optional[int] = None


def _serialize(note: Note) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "color": note.color,
        "x": note.x,
        "y": note.y,
        "width": note.width,
        "height": note.height,
        "minimized": note.minimized,
        "open": note.open,
        "sort": note.sort,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }


@router.get("/")
async def list_notes(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Note).where(Note.user_id == user.id).order_by(Note.sort, Note.updated_at.desc())
    )
    return [_serialize(n) for n in result.scalars().all()]


@router.post("/")
async def create_note(
    request: NotePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    existing = await session.execute(select(Note).where(Note.id == request.id, Note.user_id == user.id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Note already exists")
    note = Note(user_id=user.id, **request.model_dump())
    session.add(note)
    await session.flush()
    await session.refresh(note)
    return _serialize(note)


@router.patch("/{note_id}")
async def update_note(
    note_id: str,
    request: NoteUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Note).where(Note.id == note_id, Note.user_id == user.id))
    note = result.scalar_one_or_none()
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    for key, value in request.model_dump(exclude_none=True).items():
        setattr(note, key, value)
    await session.flush()
    await session.refresh(note)
    return _serialize(note)


@router.delete("/{note_id}")
async def delete_note(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Note).where(Note.id == note_id, Note.user_id == user.id))
    note = result.scalar_one_or_none()
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    await session.delete(note)
    await session.flush()
    return {"status": "deleted"}
