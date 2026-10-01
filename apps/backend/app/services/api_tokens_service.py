"""Personal Access Token (PAT) service.

Raw tokens are ``prysm_live_<48 urlsafe chars>`` and are shown once. Only the
SHA-256 hash is persisted. Lookups for PAT-authenticated requests use a
BYPASSRLS system session, because the token row must be resolvable before a
user identity (and therefore an RLS context) exists.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_token import ApiToken

TOKEN_PREFIX = "prysm_live_"


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def token_public(row: ApiToken) -> dict:
    return {
        "id": str(row.id),
        "name": row.name,
        "prefix": row.prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
    }


async def create_token(
    session: AsyncSession, user_id, name: str | None
) -> tuple[str, ApiToken]:
    raw = f"{TOKEN_PREFIX}{secrets.token_urlsafe(48)}"
    row = ApiToken(
        user_id=user_id,
        name=(name or "MCP token")[:80],
        token_hash=hash_token(raw),
        prefix=raw[:8],
    )
    session.add(row)
    await session.flush()
    return raw, row


async def lookup_token(session: AsyncSession, raw: str) -> ApiToken | None:
    if not raw or not raw.startswith(TOKEN_PREFIX):
        return None
    digest = hash_token(raw)
    result = await session.execute(
        select(ApiToken).where(ApiToken.token_hash == digest)
    )
    row = result.scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    return row


async def lookup_token_system(raw: str, session: AsyncSession | None = None) -> ApiToken | None:
    """Resolve a raw PAT, preferring a BYPASSRLS system session on Postgres."""
    if session is not None and session.get_bind().dialect.name != "postgresql":
        row = await lookup_token(session, raw)
        if row is not None:
            await stamp_used(session, row)
        return row

    from app.database import system_session_factory

    async with system_session_factory() as system:
        row = await lookup_token(system, raw)
        if row is None:
            return None
        await stamp_used(system, row)
        await system.commit()
        return row


async def list_tokens(session: AsyncSession, user_id) -> list[ApiToken]:
    result = await session.execute(
        select(ApiToken)
        .where(ApiToken.user_id == user_id)
        .order_by(ApiToken.created_at.desc())
    )
    return list(result.scalars().all())


async def revoke_token(session: AsyncSession, token_id, user_id) -> bool:
    result = await session.execute(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.user_id == user_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Token not found"
        )
    if row.revoked_at is None:
        row.revoked_at = _now()
        await session.flush()
    return True


async def stamp_used(session: AsyncSession, row: ApiToken) -> None:
    try:
        row.last_used_at = _now()
        await session.flush()
    except Exception:
        await session.rollback()
