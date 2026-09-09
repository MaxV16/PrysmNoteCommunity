import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.teams import Team, TeamInvite, TeamMember, TeamProject, TaskShare
from app.models.task import Task
from app.models.user import User
from app.services.email import send_email
from app.services.task_service import get_task
from app.routers.tasks import _serialize_task
from app.utils.ratelimit import RateLimiter
from app.utils.uuid_helpers import parse_uuid

router = APIRouter(prefix="/api/teams", tags=["teams"])

# Per-user invite rate limit: invites email real links (mailer cost + the token
# is a bearer secret), so don't let an admin spam them.
_invite_limiter = RateLimiter("rl:team_invites")
INVITE_LIMIT = 20
INVITE_WINDOW = 3600  # seconds


class CreateTeamRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("Team name must be 1-100 characters")
        return v


class InviteMemberRequest(BaseModel):
    email: str
    role: str = "member"

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return v.lower().strip()

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in {"owner", "admin", "member"}:
            raise ValueError("Role must be owner, admin or member")
        return v


class CreateProjectRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("Project name must be 1-100 characters")
        return v


class ShareTaskRequest(BaseModel):
    task_id: str


class UpdateRoleRequest(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in {"owner", "admin", "member"}:
            raise ValueError("Role must be owner, admin or member")
        return v


def _require_uuid(value: str) -> UUID:
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid id")
    return parsed


async def _get_team(session: AsyncSession, team_id: UUID) -> Team:
    result = await session.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")
    return team


async def _get_membership(session: AsyncSession, team_id: UUID, user_id) -> TeamMember | None:
    result = await session.execute(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def _require_membership(session: AsyncSession, team_id: UUID, user: User, roles: set[str]) -> TeamMember:
    member = await _get_membership(session, team_id, user.id)
    if member is None or member.role not in roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    return member


async def _serialize_team(session: AsyncSession, team: Team) -> dict:
    members_result = await session.execute(select(TeamMember).where(TeamMember.team_id == team.id))
    members = members_result.scalars().all()
    projects_result = await session.execute(select(TeamProject).where(TeamProject.team_id == team.id))
    projects = projects_result.scalars().all()
    return {
        "id": str(team.id),
        "name": team.name,
        "owner_id": str(team.owner_id),
        "members": [
            {
                "user_id": str(m.user_id),
                "email": None,  # populated per-request when visible
                "role": m.role,
            }
            for m in members
        ],
        "projects": [{"id": str(p.id), "name": p.name} for p in projects],
        "created_at": team.created_at.isoformat(),
    }


@router.get("/")
async def list_teams(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Team)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .where(TeamMember.user_id == user.id)
        .order_by(Team.created_at.desc())
    )
    teams = result.scalars().unique().all()
    serialized = []
    for team in teams:
        data = await _serialize_team(session, team)
        # Only the owner's own id + role are surfaced; email lookup per member.
        members = data["members"]
        for m in members:
            mrow = await session.execute(select(User).where(User.id == UUID(m["user_id"])))
            u = mrow.scalar_one_or_none()
            m["email"] = u.email if u else None
        my_membership = await _get_membership(session, team.id, user.id)
        data["my_role"] = my_membership.role if my_membership else "member"
        serialized.append(data)
    invites = await session.execute(
        select(TeamInvite).where(TeamInvite.status == "pending")
    )
    invites = invites.scalars().all()
    my_invites = []
    for inv in invites:
        if inv.email.lower() == (user.email or "").lower():
            team = (await session.execute(select(Team).where(Team.id == inv.team_id))).scalar_one_or_none()
            my_invites.append({
                "token": inv.token,
                "team_id": str(inv.team_id),
                "team_name": team.name if team else "Team",
                "role": inv.role,
            })
    return {"teams": serialized, "invites": my_invites}


@router.post("/")
async def create_team_route(
    request: CreateTeamRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = Team(owner_id=user.id, name=request.name)
    session.add(team)
    await session.flush()
    session.add(TeamMember(team_id=team.id, user_id=user.id, role="owner"))
    await session.flush()
    return await _serialize_team(session, team)


@router.get("/{team_id}")
async def get_team_route(
    team_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    member = await _get_membership(session, team.id, user.id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member")
    data = await _serialize_team(session, team)
    for m in data["members"]:
        u = (await session.execute(select(User).where(User.id == UUID(m["user_id"])))).scalar_one_or_none()
        m["email"] = u.email if u else None
    data["my_role"] = member.role
    return data


@router.patch("/{team_id}")
async def update_team_route(
    team_id: str,
    request: CreateTeamRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin"})
    team.name = request.name
    await session.flush()
    return await _serialize_team(session, team)


@router.delete("/{team_id}")
async def delete_team_route(
    team_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner"})
    await session.delete(team)
    await session.flush()
    return {"status": "deleted"}


@router.post("/{team_id}/members")
async def invite_member(
    team_id: str,
    request: InviteMemberRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin"})

    if _invite_limiter.count(str(user.id), INVITE_WINDOW) > INVITE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many invites - try again later",
        )

    existing = await session.execute(
        select(TeamInvite).where(
            TeamInvite.team_id == team.id,
            TeamInvite.email == request.email,
            TeamInvite.status == "pending",
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invite already pending")

    token = secrets.token_urlsafe(32)
    invite = TeamInvite(
        team_id=team.id,
        invited_by=user.id,
        email=request.email,
        role=request.role,
        token=token,
    )
    session.add(invite)
    await session.flush()

    accept_link = f"{settings.app_origin}/settings?tab=collaborate&invite={token}"
    send_email(
        request.email,
        f"You're invited to join {team.name} on Prysm Note",
        f"Join the '{team.name}' team: {accept_link}\n\nIf you don't have an account yet, register first, then open the same link.",
    )
    return {"status": "invited", "email": request.email}


@router.patch("/{team_id}/members/{user_id}")
async def update_member_role(
    team_id: str,
    user_id: str,
    request: UpdateRoleRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    actor = await _require_membership(session, team.id, user, {"owner", "admin"})
    target = await _get_membership(session, team.id, _require_uuid(user_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    # Only the owner may grant or revoke the owner role (M1). An admin must not
    # be able to promote themselves (or others) to owner - that is the only role
    # that can delete the team / manage owners.
    if request.role == "owner" or target.role == "owner":
        if actor.role != "owner":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can manage the owner role")
    # Never leave the team without an owner.
    if target.role == "owner" and request.role != "owner":
        owner_count = await session.execute(
            select(func.count())
            .select_from(TeamMember)
            .where(TeamMember.team_id == team.id, TeamMember.role == "owner")
        )
        if owner_count.scalar_one() <= 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot demote the last owner")
    target.role = request.role
    await session.flush()
    return {"status": "updated"}


@router.delete("/{team_id}/members/{user_id}")
async def remove_member(
    team_id: str,
    user_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    actor = await _require_membership(session, team.id, user, {"owner", "admin"})
    target = await _get_membership(session, team.id, _require_uuid(user_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    if target.role == "owner":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot remove the owner")
    if actor.role != "owner" and target.role != "member":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins can only remove members")
    await session.delete(target)
    await session.flush()
    return {"status": "removed"}


@router.get("/invites/{token}")
async def get_invite(
    token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(TeamInvite).where(TeamInvite.token == token))
    invite = result.scalar_one_or_none()
    if invite is None or invite.status != "pending":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found or used")
    if invite.email.lower() != (user.email or "").lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invite is for a different email")
    team = (await session.execute(select(Team).where(Team.id == invite.team_id))).scalar_one_or_none()
    return {
        "team_id": str(invite.team_id),
        "team_name": team.name if team else "Team",
        "email": invite.email,
        "role": invite.role,
    }


@router.post("/invites/{token}/accept")
async def accept_invite(
    token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(TeamInvite).where(TeamInvite.token == token))
    invite = result.scalar_one_or_none()
    if invite is None or invite.status != "pending":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found or used")
    if invite.email.lower() != (user.email or "").lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invite is for a different email")

    member = await _get_membership(session, invite.team_id, user.id)
    if member is None:
        session.add(TeamMember(team_id=invite.team_id, user_id=user.id, role=invite.role))
    invite.status = "accepted"
    await session.flush()
    return {"status": "joined", "team_id": str(invite.team_id)}


@router.post("/invites/{token}/decline")
async def decline_invite(
    token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(TeamInvite).where(TeamInvite.token == token))
    invite = result.scalar_one_or_none()
    if invite is None or invite.status != "pending":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found or used")
    # Only the invited email may decline, so a leaked token can't burn someone
    # else's invite (L1).
    if invite.email.lower() != (user.email or "").lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invite is for a different email")
    invite.status = "declined"
    await session.flush()
    return {"status": "declined"}


@router.post("/{team_id}/projects")
async def create_project(
    team_id: str,
    request: CreateProjectRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin", "member"})
    project = TeamProject(team_id=team.id, name=request.name)
    session.add(project)
    await session.flush()
    return {"id": str(project.id), "name": project.name}


@router.delete("/{team_id}/projects/{project_id}")
async def delete_project(
    team_id: str,
    project_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin"})
    await session.execute(
        delete(TeamProject).where(
            TeamProject.id == _require_uuid(project_id),
            TeamProject.team_id == team.id,
        )
    )
    await session.flush()
    return {"status": "deleted"}


@router.post("/{team_id}/share-task")
async def share_task(
    team_id: str,
    request: ShareTaskRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin", "member"})
    task = await get_task(session, _require_uuid(request.task_id), user.id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if task.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the task owner can share it")

    exists = await session.execute(
        select(TaskShare).where(TaskShare.task_id == task.id, TaskShare.team_id == team.id)
    )
    if exists.scalar_one_or_none():
        return {"status": "already_shared"}
    session.add(TaskShare(task_id=task.id, team_id=team.id, shared_by=user.id))
    await session.flush()
    return {"status": "shared", "task_id": str(task.id)}


@router.delete("/{team_id}/share-task/{task_id}")
async def unshare_task(
    team_id: str,
    task_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin", "member"})
    await session.execute(
        delete(TaskShare).where(
            TaskShare.task_id == _require_uuid(task_id),
            TaskShare.team_id == team.id,
        )
    )
    await session.flush()
    return {"status": "unshared"}


@router.get("/{team_id}/tasks")
async def team_tasks(
    team_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    team = await _get_team(session, _require_uuid(team_id))
    await _require_membership(session, team.id, user, {"owner", "admin", "member"})
    shared_ids = select(TaskShare.task_id).where(TaskShare.team_id == team.id)
    result = await session.execute(
        select(Task).where(Task.id.in_(shared_ids), Task.deleted_at.is_(None)).order_by(Task.created_at.desc())
    )
    return [_serialize_task(t) for t in result.scalars().all()]
