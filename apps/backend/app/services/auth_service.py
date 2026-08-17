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
        password_hash=hash_password(password),
        display_name=display_name,
    )
    session.add(user)
    await session.flush()
    return user
