import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from bcrypt import checkpw, gensalt, hashpw
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User


def hash_password(password: str) -> str:
    return hashpw(password.encode(), gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return checkpw(password.encode(), password_hash.encode())


async def hash_password_async(password: str) -> str:
    """Hash on a worker thread: bcrypt is CPU-bound and blocks the event loop."""
    return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password: str, password_hash: str) -> bool:
    """Verify on a worker thread so a slow bcrypt never stalls the loop."""
    return await asyncio.to_thread(verify_password, password, password_hash)


def create_access_token(user_id: str, token_version: int = 0) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": user_id, "exp": expires, "type": "access", "jti": str(uuid4()), "tv": token_version},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


def create_refresh_token(user_id: str, token_version: int = 0) -> str:
    expires = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    return jwt.encode(
        {"sub": user_id, "exp": expires, "type": "refresh", "jti": str(uuid4()), "tv": token_version},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def create_user(session: AsyncSession, email: str, password: str, display_name: str | None = None) -> User:
    user = User(
        email=email,
        password_hash=await hash_password_async(password),
        display_name=display_name,
    )
    session.add(user)
    await session.flush()
    return user
