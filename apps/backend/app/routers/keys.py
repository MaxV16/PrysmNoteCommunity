from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.api_key import ApiKey
from app.models.user import User
from app.utils.encryption import encrypt_api_key

VALID_PROVIDERS = {"openai", "gemini", "deepseek"}

router = APIRouter(prefix="/api/keys", tags=["keys"])


class SaveKeyRequest(BaseModel):
    provider: str
    api_key: str

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        if v not in VALID_PROVIDERS:
            raise ValueError(f"Invalid provider. Must be one of: {', '.join(sorted(VALID_PROVIDERS))}")
        return v

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 8:
            raise ValueError("API key too short")
        if len(v) > 256:
            raise ValueError("API key too long")
        return v


class KeyResponse(BaseModel):
    id: str
    provider: str
    key_prefix: str
    is_active: bool


@router.get("/")
async def list_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(ApiKey).where(ApiKey.user_id == user.id)
    )
    return [
        KeyResponse(
            id=str(k.id),
            provider=k.provider,
            key_prefix=k.key_prefix or "",
            is_active=k.is_active,
        )
        for k in result.scalars().all()
    ]


@router.post("/")
async def save_key(
    request: SaveKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user.id,
            ApiKey.provider == request.provider,
        )
    )
    existing = result.scalar_one_or_none()
    encrypted = encrypt_api_key(request.api_key)

    if existing:
        existing.encrypted_key = encrypted
        existing.key_prefix = request.api_key[:8]
        existing.is_active = True
    else:
        key = ApiKey(
            user_id=user.id,
            provider=request.provider,
            encrypted_key=encrypted,
            key_prefix=request.api_key[:8],
        )
        session.add(key)

    await session.flush()
    return {"status": "saved", "provider": request.provider}


class SyncKeyRequest(BaseModel):
    provider: str
    api_key: str

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        if v not in VALID_PROVIDERS:
            raise ValueError(f"Invalid provider. Must be one of: {', '.join(sorted(VALID_PROVIDERS))}")
        return v

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 8:
            raise ValueError("API key too short")
        if len(v) > 256:
            raise ValueError("API key too long")
        return v


@router.post("/sync")
async def sync_key(
    request: SyncKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user.id,
            ApiKey.provider == request.provider,
        )
    )
    existing = result.scalar_one_or_none()
    encrypted = encrypt_api_key(request.api_key)

    if existing:
        existing.encrypted_key = encrypted
        existing.key_prefix = request.api_key[:8]
        existing.is_active = True
    else:
        key = ApiKey(
            user_id=user.id,
            provider=request.provider,
            encrypted_key=encrypted,
            key_prefix=request.api_key[:8],
        )
        session.add(key)

    await session.commit()
    return {"status": "synced", "provider": request.provider}


class TestKeyRequest(BaseModel):
    provider: str
    api_key: str

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        if v not in VALID_PROVIDERS:
            raise ValueError(f"Invalid provider. Must be one of: {', '.join(sorted(VALID_PROVIDERS))}")
        return v

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 8:
            raise ValueError("API key too short")
        if len(v) > 256:
            raise ValueError("API key too long")
        return v


@router.post("/test")
async def test_key(request: TestKeyRequest):
    import httpx
    provider = request.provider
    api_key = request.api_key

    try:
        if provider == "openai":
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10,
                )
                return {"valid": resp.status_code == 200, "error": None if resp.status_code == 200 else f"HTTP {resp.status_code}"}

        elif provider == "deepseek":
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    "https://api.deepseek.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10,
                )
                return {"valid": resp.status_code == 200, "error": None if resp.status_code == 200 else f"HTTP {resp.status_code}"}

        elif provider == "gemini":
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
                    timeout=10,
                )
                return {"valid": resp.status_code == 200, "error": None if resp.status_code == 200 else f"HTTP {resp.status_code}"}

        return {"valid": False, "error": f"Unknown provider: {provider}"}
    except httpx.TimeoutException:
        return {"valid": False, "error": "Request timed out — check network connectivity"}
    except Exception as e:
        return {"valid": False, "error": str(e)}


@router.delete("/{key_id}")
async def delete_key(
    key_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == user.id)
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    await session.delete(key)
    await session.flush()
    return {"status": "deleted"}