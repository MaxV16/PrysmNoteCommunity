from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.board_section import BoardSection
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.utils.uuid_helpers import parse_uuid

router = APIRouter(prefix="/api/board-sections", tags=["board-sections"])

VALID_KINDS = {"kanban", "board"}
VALID_STATUSES = {s.value for s in TaskStatus}

DEFAULT_KANBAN_SECTIONS = (
    ("backlog", "Backlog", "#9E9E9E"),
    ("todo", "To Do", "#4FC3F7"),
    ("in_progress", "In Progress", "#FFA726"),
    ("done", "Done", "#66BB6A"),
)


def _require_uuid(value: str):
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed


def _serialize(section: BoardSection) -> dict:
    return {
        "id": str(section.id),
        "kind": section.kind,
        "title": section.title,
        "color": section.color,
        "status": section.status,
        "position": section.position,
    }


async def _get_section(session: AsyncSession, section_id, user_id) -> BoardSection | None:
    result = await session.execute(
        select(BoardSection).where(BoardSection.id == section_id, BoardSection.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def _next_position(session: AsyncSession, user_id, kind: str) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(BoardSection.position), -1)).where(
            BoardSection.user_id == user_id, BoardSection.kind == kind
        )
    )
    return int(result.scalar_one()) + 1


class BoardSectionCreate(BaseModel):
    kind: str
    title: str
    color: str | None = None
    status: str | None = None
    position: int | None = None

    @field_validator("kind")
    @classmethod
    def validate_kind(cls, v: str) -> str:
        if v not in VALID_KINDS:
            raise ValueError(f"Invalid kind. Must be one of: {', '.join(sorted(VALID_KINDS))}")
        return v

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Title is required")
        if len(v) > 200:
            raise ValueError("Title must be at most 200 characters")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_STATUSES:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}")
        return v


class BoardSectionUpdate(BaseModel):
    title: str | None = None
    color: str | None = None
    position: int | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Title must not be empty")
            if len(v) > 200:
                raise ValueError("Title must be at most 200 characters")
        return v


@router.get("/")
async def list_sections(
    kind: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """List a board kind's sections, lazily seeding the 4 default kanban sections
    the first time a user opens the kanban (the board kind starts empty)."""
    if kind not in VALID_KINDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid kind")

    result = await session.execute(
        select(BoardSection)
        .where(BoardSection.user_id == user.id, BoardSection.kind == kind)
        .order_by(BoardSection.position, BoardSection.created_at)
    )
    sections = list(result.scalars().all())

    if not sections and kind == "kanban":
        for position, (sec_status, title, color) in enumerate(DEFAULT_KANBAN_SECTIONS):
            session.add(
                BoardSection(
                    user_id=user.id,
                    kind="kanban",
                    title=title,
                    color=color,
                    status=sec_status,
                    position=position,
                )
            )
        await session.flush()
        sections = list(
            (
                await session.execute(
                    select(BoardSection)
                    .where(BoardSection.user_id == user.id, BoardSection.kind == kind)
                    .order_by(BoardSection.position)
                )
            ).scalars().all()
        )

    return [_serialize(s) for s in sections]


@router.post("/")
async def create_section(
    request: BoardSectionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Create a section. Status sections upsert by (user_id, kind, status) so the
    frontend's one-time localStorage migration can converge titles/colors onto the
    seeded defaults; free sections always insert."""
    if request.status:
        result = await session.execute(
            select(BoardSection).where(
                BoardSection.user_id == user.id,
                BoardSection.kind == request.kind,
                BoardSection.status == request.status,
            )
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            existing.title = request.title
            if request.color:
                existing.color = request.color
            if request.position is not None:
                existing.position = request.position
            await session.flush()
            await session.refresh(existing)
            return _serialize(existing)

    section = BoardSection(
        user_id=user.id,
        kind=request.kind,
        title=request.title,
        color=request.color,
        status=request.status,
        position=request.position if request.position is not None else await _next_position(session, user.id, request.kind),
    )
    session.add(section)
    await session.flush()
    await session.refresh(section)
    return _serialize(section)


@router.patch("/{section_id}")
async def update_section(
    section_id: str,
    request: BoardSectionUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    section = await _get_section(session, _require_uuid(section_id), user.id)
    if section is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")
    for key, value in request.model_dump(exclude_none=True).items():
        setattr(section, key, value)
    await session.flush()
    await session.refresh(section)
    return _serialize(section)


@router.delete("/{section_id}")
async def delete_section(
    section_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    section = await _get_section(session, _require_uuid(section_id), user.id)
    if section is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

    # Explicitly clear membership before deleting. The tasks FK has ON DELETE
    # SET NULL (alembic 0011), but doing it here makes deletion safe on every
    # database (including ones where the column was provisioned without the FK).
    await session.execute(
        Task.__table__.update()
        .where(Task.board_section_id == section.id, Task.user_id == user.id)
        .values(board_section_id=None)
    )
    await session.delete(section)
    await session.flush()
    return {"status": "deleted"}

