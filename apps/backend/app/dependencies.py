from typing import cast
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_factory, get_db
from app.models.token_blacklist import TokenBlacklist
from app.models.user import User

security = HTTPBearer()
security_optional = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security_optional),
    session: AsyncSession = Depends(get_db),
) -> User:
    token = None
    if credentials:
        token = credentials.credentials
    else:
        token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        user_id = payload.get("sub")
        token_type = payload.get("type")
        if user_id is None or token_type != "access":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    jti = payload.get("jti")
    if jti:
        blacklisted = await session.execute(
            select(TokenBlacklist).where(TokenBlacklist.jti == jti)
        )
        if blacklisted.scalar_one_or_none():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    result = await session.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # Password reset bumps token_version; any pre-reset token (which carries the
    # old version) is rejected even if still unexpired.
    if payload.get("tv", 0) != user.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    # RLS session variables are PostgreSQL-only (SQLite/tests skip them); the
    # conftest's _get_test_db applies RLS for Postgres test runs instead.
    if session.get_bind().dialect.name == "postgresql":
        # Set both RLS session variables in ONE round trip (was two statements).
        await session.execute(
            text(
                "SELECT set_config('app.user_id', :user_id, true), "
                "set_config('app.user_email', :email, true)"
            ).bindparams(user_id=str(user.id), email=user.email)
        )
    return user


async def get_current_user_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security_optional),
) -> UUID:
    """Authenticate and return just the user id.

    Unlike ``get_current_user`` this opens its own short-lived session and closes
    it before returning, so a long-lived SSE stream never pins a pooled DB
    connection for its whole lifetime.
    """
    token = credentials.credentials if credentials else request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        user_id = payload.get("sub")
        if user_id is None or payload.get("type") != "access":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    async with async_session_factory() as session:
        jti = payload.get("jti")
        if jti:
            blacklisted = await session.execute(
                select(TokenBlacklist).where(TokenBlacklist.jti == jti)
            )
            if blacklisted.scalar_one_or_none():
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
        result = await session.execute(select(User).where(User.id == UUID(user_id)))
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        if payload.get("tv", 0) != user.token_version:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
        return cast(UUID, user.id)
