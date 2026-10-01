"""Personal Access Token endpoints for the MCP server (and other API clients).

Core and ungated: creating a token is a normal user action. The MCP server
itself enforces the subscription gate (via ``is_premium``) when a token is
actually used, so token management stays available to every signed-in user.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services import api_tokens_service
from app.utils.client_ip import _client_ip
from app.utils.ratelimit import RateLimiter
from app.utils.uuid_helpers import require_uuid

router = APIRouter(prefix="/api/tokens", tags=["tokens"])

_token_create_limiter = RateLimiter("rl:pat_create")


class TokenCreateRequest(BaseModel):
    name: str = Field(default="MCP token", max_length=80)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_token(
    body: TokenCreateRequest,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    ip = _client_ip(request)
    if _token_create_limiter.count(f"user:{user.id}:ip:{ip}", 3600) > 10:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many tokens created. Try again later.",
        )
    raw, row = await api_tokens_service.create_token(session, user.id, body.name.strip())
    await session.commit()
    return {
        "id": str(row.id),
        "name": row.name,
        "prefix": row.prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "plaintext": raw,
    }


@router.get("")
async def list_tokens(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    rows = await api_tokens_service.list_tokens(session, user.id)
    return {"tokens": [api_tokens_service.token_public(r) for r in rows]}


@router.delete("/{token_id}")
async def revoke_token(
    token_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    await api_tokens_service.revoke_token(session, require_uuid(token_id), user.id)
    await session.commit()
    return {"revoked": True, "id": token_id}
