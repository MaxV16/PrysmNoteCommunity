import re
import time
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from jose import JWTError, jwt
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.auth_service import (
    create_access_token,
    create_refresh_token,
    create_user,
    get_user_by_email,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_IP_BLOCKLIST: set[str] = set()

class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str | None = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
            raise ValueError("Invalid email format")
        return v.lower().strip()

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v) > 128:
            raise ValueError("Password must be at most 128 characters")
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if len(v) > 100:
                raise ValueError("Display name must be at most 100 characters")
        return v


class LoginRequest(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return v.lower().strip()


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: dict


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/register")
async def register(request: RegisterRequest, response: Response, req: Request, session: AsyncSession = Depends(get_db)):
    ip = _get_client_ip(req)
    if ip in _IP_BLOCKLIST:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="IP blocked")

    existing = await get_user_by_email(session, request.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    user = await create_user(session, request.email, request.password, request.display_name)
    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/login")
async def login(request: LoginRequest, response: Response, req: Request, session: AsyncSession = Depends(get_db)):
    ip = _get_client_ip(req)
    if ip in _IP_BLOCKLIST:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="IP blocked")

    user = await get_user_by_email(session, request.email)
    if not user or not user.password_hash or not verify_password(request.password, user.password_hash):
        _track_failed_login(ip)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/refresh")
async def refresh(
    response: Response,
    request: RefreshRequest | None = None,
    refresh_token: str | None = Cookie(None),
    session: AsyncSession = Depends(get_db),
):
    token = refresh_token or (request.refresh_token if request else None)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required")
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = await session.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"status": "logged_out"}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat(),
    }


class UpdateMeRequest(BaseModel):
    display_name: str | None = None
    email: str | None = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str | None) -> str | None:
        if v is not None:
            if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
                raise ValueError("Invalid email format")
            return v.lower().strip()
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if len(v) > 100:
                raise ValueError("Display name must be at most 100 characters")
        return v


@router.patch("/me")
async def update_me(
    request: UpdateMeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if request.email is not None:
        existing = await get_user_by_email(session, request.email)
        if existing and str(existing.id) != str(user.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
        user.email = request.email
    if request.display_name is not None:
        user.display_name = request.display_name
    await session.flush()
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat(),
    }


def _get_client_ip(req: Request) -> str:
    forwarded = req.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return req.client.host if req.client else "unknown"


_FAILED_LOGINS: dict[str, list[float]] = {}

def _track_failed_login(ip: str) -> None:
    now = time.time()
    if ip not in _FAILED_LOGINS:
        _FAILED_LOGINS[ip] = []
    _FAILED_LOGINS[ip] = [t for t in _FAILED_LOGINS[ip] if now - t < 300]
    _FAILED_LOGINS[ip].append(now)
    if len(_FAILED_LOGINS[ip]) >= 10:
        _IP_BLOCKLIST.add(ip)