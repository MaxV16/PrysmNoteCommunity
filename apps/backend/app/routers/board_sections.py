from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.board_section import BoardSection
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.models.user_preference import UserPreference
from app.utils.cache import cache_delete_prefix, cache_get, cache_set, user_cache_key
from app.utils.ratelimit import RateLimiter
from app.utils.uuid_helpers import parse_uuid

router = APIRouter(prefix="/api/board-sections", tags=["board-sections"])

VALID_KINDS = {"kanban", "board", "timeline"}
VALID_STATUSES = {s.value for s in TaskStatus}

SECTIONS_CACHE_TTL = 20

# Seed-once marker. Defaults are only created when the marker is absent, so an
# empty list is a real user choice that must survive a refresh instead of being
# lazily re-seeded on every fetch (the deleted-sections-come-back bug). Only
# kanban still seeds; timeline sections are per-list and never auto-created.
SEED_FLAG_PREFIX = "prysm_board_sections_seeded_"

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


def _parse_list_id(value: str | None):
    """Coerce the optional ``list_id`` query/body value to a UUID.

    An empty string (the frontend's "no list selected") maps to ``None``, which
    means the workspace-wide scope (``list_id IS NULL``). A malformed value is a
    422 rather than a raw uuid cast error.
    """
    if value is None or value == "":
        return None
    parsed = parse_uuid(str(value))
    if parsed is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid list_id"
        )
    return parsed


def _serialize(section: BoardSection) -> dict:
    return {
        "id": str(section.id),
        "kind": section.kind,
        "list_id": str(section.list_id) if section.list_id else None,
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


async def _next_position(session: AsyncSession, user_id, kind: str, list_id) -> int:
    conditions = [BoardSection.user_id == user_id, BoardSection.kind == kind]
    conditions.append(
        BoardSection.list_id.is_(None) if list_id is None else BoardSection.list_id == list_id
    )
    result = await session.execute(
        select(func.coalesce(func.max(BoardSection.position), -1)).where(*conditions)
    )
    return int(result.scalar_one()) + 1


async def _seeded_flag(session: AsyncSession, user_id, kind: str) -> bool:
    result = await session.execute(
        select(UserPreference).where(
            UserPreference.user_id == user_id,
            UserPreference.key == f"{SEED_FLAG_PREFIX}{kind}",
        )
    )
    return result.scalar_one_or_none() is not None


async def _claim_seed(session: AsyncSession, user_id, kind: str) -> bool:
    """Atomically claim the one-time default-seed for ``(user, kind)``.

    Returns True only for the caller that won the claim. The marker insert runs
    inside a SAVEPOINT, so a concurrent winner's row raises ``IntegrityError``
    that rolls back only the savepoint and leaves the request transaction (and
    its RLS context) intact. The previous SELECT-then-INSERT pair raced here:
    two first loads could both decide to seed, and the loser 500'd on the
    unique ``uq_user_preferences_user_key`` constraint.
    """
    key = f"{SEED_FLAG_PREFIX}{kind}"
    try:
        async with session.begin_nested():
            session.add(UserPreference(user_id=user_id, key=key, value=True))
            await session.flush()
    except IntegrityError:
        return False
    return True


async def _list_sections(session: AsyncSession, user_id, kind: str, list_id) -> list[BoardSection]:
    conditions = [BoardSection.user_id == user_id, BoardSection.kind == kind]
    conditions.append(
        BoardSection.list_id.is_(None) if list_id is None else BoardSection.list_id == list_id
    )
    result = await session.execute(
        select(BoardSection)
        .where(*conditions)
        .order_by(BoardSection.position, BoardSection.created_at)
    )
    return list(result.scalars().all())


class BoardSectionCreate(BaseModel):
    kind: str
    title: str
    color: str | None = None
    status: str | None = None
    position: int | None = None
    list_id: str | None = None

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
    list_id: str | None = Query(None, description="scope to one task list; empty = no list"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """List a board kind's sections, scoped to one list (or the no-list scope).

    Only kanban still seeds defaults, at most ONCE per user and kind (tracked by
    a ``prysm_board_sections_seeded_<kind>`` preference). Timeline sections are
    now per-list and are never auto-created: a brand-new list starts with no
    sections until the user adds one.
    """
    if kind not in VALID_KINDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid kind")

    target_list = _parse_list_id(list_id)
    cache_key = user_cache_key("board_sections", user.id, kind, str(target_list) if target_list else "none")
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    sections = await _list_sections(session, user.id, kind, target_list)

    if sections:
        # Self-heal existing users who predate the seed marker: once they have
        # kanban sections, remember that this kind was seeded so a later
        # delete-all sticks.
        if kind == "kanban" and not await _seeded_flag(session, user.id, kind):
            await _claim_seed(session, user.id, kind)
        payload = [_serialize(s) for s in sections]
        await cache_set(cache_key, payload, SECTIONS_CACHE_TTL)
        return payload

    # Timeline never seeds. An empty result is the user's real choice.
    if kind == "timeline":
        await cache_set(cache_key, [], SECTIONS_CACHE_TTL)
        return []

    # Marker present and no sections: the user deleted every default, and that
    # empty list is a real choice that must stay empty.
    if await _seeded_flag(session, user.id, kind):
        await cache_set(cache_key, [], SECTIONS_CACHE_TTL)
        return []

    # No marker: this is a first load. Claim the seed atomically so two
    # concurrent first loads cannot both seed; the loser returns [] and sees the
    # winner's rows on its next fetch.
    if not await _claim_seed(session, user.id, kind):
        return []

    defaults = {
        "kanban": DEFAULT_KANBAN_SECTIONS,
    }.get(kind)
    if defaults is not None:
        for position, (sec_status, title, color) in enumerate(defaults):
            session.add(
                BoardSection(
                    user_id=user.id,
                    kind=kind,
                    list_id=target_list,
                    title=title,
                    color=color,
                    status=sec_status,
                    position=position,
                )
            )

    sections = await _list_sections(session, user.id, kind, target_list)
    payload = [_serialize(s) for s in sections]
    await cache_set(cache_key, payload, SECTIONS_CACHE_TTL)
    return payload


@router.post("/")
async def create_section(
    request: BoardSectionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Create a section. Status sections upsert by (user_id, kind, list_id,
    status) so the frontend's one-time localStorage migration can converge
    titles/colors onto the seeded defaults; free sections always insert."""
    target_list = _parse_list_id(request.list_id)
    if request.status:
        result = await session.execute(
            select(BoardSection).where(
                BoardSection.user_id == user.id,
                BoardSection.kind == request.kind,
                BoardSection.list_id.is_(None) if target_list is None else BoardSection.list_id == target_list,
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
            await cache_delete_prefix(user_cache_key("board_sections", user.id))
            return _serialize(existing)

    section = BoardSection(
        user_id=user.id,
        kind=request.kind,
        list_id=target_list,
        title=request.title,
        color=request.color,
        status=request.status,
        position=request.position if request.position is not None else await _next_position(session, user.id, request.kind, target_list),
    )
    session.add(section)
    await session.flush()
    await session.refresh(section)
    await cache_delete_prefix(user_cache_key("board_sections", user.id))
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
    await cache_delete_prefix(user_cache_key("board_sections", user.id))
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
    await cache_delete_prefix(user_cache_key("board_sections", user.id))
    return {"status": "deleted"}


class AutoOrganizeRequest(BaseModel):
    force: bool = False
    provider: str | None = None
    list_id: str | None = None


# Dedicated limiter (same Redis namespace as chat) so an expensive multi-call
# organizer run cannot be spammed. In-memory fallback is used without Redis.
_organize_limiter = RateLimiter("rl:ai")
ORGANIZE_MAX_PER_HOUR = 6


def _check_organize_rate_limit(user_id) -> None:
    if _organize_limiter.count(f"organize:{user_id}", 3600) >= ORGANIZE_MAX_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Auto-sort was used too many times in the last hour. Try again later.",
        )


@router.post("/auto-organize")
async def auto_organize(
    request: AutoOrganizeRequest,
    http_request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """AI-classify dated tasks into timeline topic sections (see
    ``app/services/timeline_organizer.py``). Spends the user's own AI access.
    Scoped to the requested task list (or the no-list scope) so sections and the
    tasks they group stay per-list."""
    _check_organize_rate_limit(user.id)
    from app.services.timeline_organizer import organize_timeline

    result = await organize_timeline(
        session,
        user,
        http_request=http_request,
        provider=request.provider,
        force=request.force,
        list_id=_parse_list_id(request.list_id),
    )
    await cache_delete_prefix(user_cache_key("board_sections", user.id))
    return result


