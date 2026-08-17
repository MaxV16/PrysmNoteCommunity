import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.api_key import ApiKey
from app.models.user import User
from app.utils.encryption import encrypt_api_key

VALID_PROVIDERS = {"openai", "gemini", "deepseek", "openrouter"}

router = APIRouter(prefix="/api/keys", tags=["keys"])

# In-memory per-user rate limit for /test: forwards user-supplied keys to
# third-party providers from the server IP, so it must not be an open proxy.
_TEST_KEY_LIMIT = 10
_TEST_KEY_WINDOW = 60  # seconds
_test_key_calls: dict[str, list[float]] = {}


def _test_key_allowed(user_id: str) -> bool:
    now = time.time()
    calls = [t for t in _test_key_calls.get(user_id, []) if now - t < _TEST_KEY_WINDOW]
    if len(calls) >= _TEST_KEY_LIMIT:
        _test_key_calls[user_id] = calls
        return False
    calls.append(now)
    _test_key_calls[user_id] = calls
    return True


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


@router.get("/{provider}/key")
async def get_provider_key(
    provider: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Securely return the caller's own stored API key for a provider.

    Used to re-hydrate the client-side cache (e.g. on a fresh tab/session) so a
    user doesn't have to re-enter a key they already saved. Only returns a key
    that belongs to the authenticated user, is active, and is a known provider.
    The key is never logged and is only transmitted to the authenticated owner
    over TLS.
    """
    if provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid provider")

    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user.id,
            ApiKey.provider == provider,
            ApiKey.is_active.is_(True),
        )
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No key stored for this provider")

    from app.utils.encryption import decrypt_api_key
    api_key = decrypt_api_key(key.encrypted_key)
    return {"provider": provider, "api_key": api_key}


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
async def test_key(
    request: TestKeyRequest,
    user: User = Depends(get_current_user),
):
    if not _test_key_allowed(str(user.id)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many key tests — try again shortly",
        )
    import httpx
    import logging

    logger = logging.getLogger("app.keys")
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

        elif provider == "openrouter":
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10,
                )
                return {"valid": resp.status_code == 200, "error": None if resp.status_code == 200 else f"HTTP {resp.status_code}"}

        return {"valid": False, "error": f"Unknown provider: {provider}"}
    except httpx.TimeoutException:
        return {"valid": False, "error": "Request timed out — check network connectivity"}
    except Exception as e:
        # Never relay raw exception text (paths, hostnames, provider quirks) to
        # the client; log it server-side instead.
        logger.warning("key test failed for provider=%s: %s", provider, e)
        return {"valid": False, "error": "Could not validate the key — please try again"}


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