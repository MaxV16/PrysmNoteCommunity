from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.timeline_section import TimelineSection
from app.models.user import User
from app.utils.uuid_helpers import parse_uuid

router = APIRouter(prefix="/api/timeline-sections", tags=["timeline-sections"])

VALID_RULE_KINDS = {"list", "tag", "priority", "status", "all"}

NAME_MAX = 80
VALUE_MAX = 200


def _require_uuid(value: str):
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed


def _serialize(section: TimelineSection) -> dict:
    return {
        "id": str(section.id),
        "name": section.name,
        "color": section.color,
        "start_pct": section.start_pct,
        "end_pct": section.end_pct,
        "rule_kind": section.rule_kind,
        "rule_value": section.rule_value,
        "position": section.position,
    }


async def _get_section(session: AsyncSession, section_id, user_id) -> TimelineSection | None:
    result = await session.execute(
        select(TimelineSection).where(TimelineSection.id == section_id, TimelineSection.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def _next_position(session: AsyncSession, user_id) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(TimelineSection.position), -1)).where(TimelineSection.user_id == user_id)
    )
    return int(result.scalar_one()) + 1


class TimelineSectionCreate(BaseModel):
    name: str
    color: str | None = None
    start_pct: int = 50
    end_pct: int = 100
    rule_kind: str | None = None
    rule_value: str | None = None
    position: int | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        if len(v) > NAME_MAX:
            raise ValueError(f"Name must be at most {NAME_MAX} characters")
        return v

    @field_validator("start_pct", "end_pct")
    @classmethod
    def validate_pct(cls, v: int) -> int:
        if v < 0 or v > 100:
            raise ValueError("Percentages must be between 0 and 100")
        return v

    @field_validator("rule_kind")
    @classmethod
    def validate_rule_kind(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_RULE_KINDS:
            raise ValueError(f"Invalid rule kind. Must be one of: {', '.join(sorted(VALID_RULE_KINDS))}")
        return v

    @field_validator("rule_value")
    @classmethod
    def validate_rule_value(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if len(v) > VALUE_MAX:
                raise ValueError(f"Rule value must be at most {VALUE_MAX} characters")
            if not v:
                return None
        return v


class TimelineSectionUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    start_pct: int | None = None
    end_pct: int | None = None
    rule_kind: str | None = None
    rule_value: str | None = None
    position: int | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Name must not be empty")
            if len(v) > NAME_MAX:
                raise ValueError(f"Name must be at most {NAME_MAX} characters")
        return v

    @field_validator("start_pct", "end_pct")
    @classmethod
    def validate_pct(cls, v: int | None) -> int | None:
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Percentages must be between 0 and 100")
        return v

    @field_validator("rule_kind")
    @classmethod
    def validate_rule_kind(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_RULE_KINDS:
            raise ValueError(f"Invalid rule kind. Must be one of: {', '.join(sorted(VALID_RULE_KINDS))}")
        return v

    @field_validator("rule_value")
    @classmethod
    def validate_rule_value(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                return None
            if len(v) > VALUE_MAX:
                raise ValueError(f"Rule value must be at most {VALUE_MAX} characters")
        return v


@router.get("/")
async def list_sections(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(TimelineSection)
        .where(TimelineSection.user_id == user.id)
        .order_by(TimelineSection.position, TimelineSection.created_at)
    )
    return [_serialize(s) for s in result.scalars().all()]


@router.post("/")
async def create_section(
    request: TimelineSectionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if request.start_pct >= request.end_pct:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_pct must be less than end_pct",
        )
    section = TimelineSection(
        user_id=user.id,
        name=request.name,
        color=request.color,
        start_pct=request.start_pct,
        end_pct=request.end_pct,
        rule_kind=request.rule_kind,
        rule_value=request.rule_value,
        position=request.position if request.position is not None else await _next_position(session, user.id),
    )
    session.add(section)
    await session.flush()
    await session.refresh(section)
    return _serialize(section)


@router.patch("/{section_id}")
async def update_section(
    section_id: str,
    request: TimelineSectionUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    section = await _get_section(session, _require_uuid(section_id), user.id)
    if section is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")
    data = request.model_dump(exclude_none=True)
    new_start = data.get("start_pct", section.start_pct)
    new_end = data.get("end_pct", section.end_pct)
    if new_start >= new_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_pct must be less than end_pct",
        )
    for key, value in data.items():
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
    await session.delete(section)
    await session.flush()
    return {"status": "deleted"}