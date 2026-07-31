from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.project import Project
from app.models.task import Task
from app.models.user import User

router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str
    color: str | None = None
    icon: str | None = None
    parent_id: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("name must not be empty")
        if len(v) > 255:
            raise ValueError("name must be 255 characters or fewer")
        return v


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
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A project with this name already exists")
    return {"id": str(project.id), "name": project.name, "color": project.color}


@router.get("/{project_id}")
async def get_project_route(
    project_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(Project).where(Project.id == UUID(project_id), Project.user_id == user.id, Project.is_archived == False)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    tasks_count = await session.scalar(
        select(func.count()).select_from(Task).where(Task.project_id == project.id, Task.is_archived == False)
    )
    return {
        "id": str(project.id),
        "name": project.name,
        "color": project.color,
        "icon": project.icon,
        "task_count": tasks_count or 0,
    }


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
