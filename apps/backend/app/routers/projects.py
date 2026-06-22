from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.project import Project
from app.models.user import User

router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str
    color: str | None = None
    icon: str | None = None
    parent_id: str | None = None


@router.get("/")
async def list_projects(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Project).where(Project.user_id == user.id, Project.is_archived == False).order_by(Project.sort_order)
    )
    return [
        {"id": str(p.id), "name": p.name, "color": p.color, "icon": p.icon}
        for p in result.scalars().all()
    ]


@router.post("/")
async def create_project_route(
    request: CreateProjectRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    project = Project(
        user_id=user.id,
        name=request.name,
        color=request.color,
        icon=request.icon,
        parent_id=UUID(request.parent_id) if request.parent_id else None,
    )
    session.add(project)
    await session.flush()
    return {"id": str(project.id), "name": project.name, "color": project.color}


class UpdateProjectRequest(BaseModel):
    name: str | None = None
    color: str | None = None
    icon: str | None = None


@router.patch("/{project_id}")
async def update_project_route(
    project_id: str,
    request: UpdateProjectRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Project).where(Project.id == UUID(project_id), Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if request.name is not None:
        project.name = request.name
    if request.color is not None:
        project.color = request.color
    if request.icon is not None:
        project.icon = request.icon
    await session.flush()
    return {"id": str(project.id), "name": project.name, "color": project.color, "icon": project.icon}


@router.delete("/{project_id}")
async def delete_project_route(
    project_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Project).where(Project.id == UUID(project_id), Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    project.is_archived = True
    await session.flush()
    return {"status": "archived"}
