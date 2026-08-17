import pytest
from uuid import uuid4

from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.api_key import ApiKey
from app.models.user import User
from app.utils.encryption import encrypt_api_key


@pytest.mark.asyncio
async def test_get_provider_key_returns_own_key(client: AsyncClient, db_session: AsyncSession, test_user: User, monkeypatch):
    monkeypatch.setattr(settings, "encryption_key", Fernet.generate_key().decode())
    db_session.add(ApiKey(
        user_id=test_user.id,
        provider="deepseek",
        encrypted_key=encrypt_api_key("sk-12345678"),
        key_prefix="sk-12345",
        is_active=True,
    ))
    await db_session.commit()

    res = await client.get("/api/keys/deepseek/key")
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "deepseek"
    assert data["api_key"] == "sk-12345678"


@pytest.mark.asyncio
async def test_get_provider_key_does_not_leak_other_users_key(client: AsyncClient, db_session: AsyncSession, test_user: User, monkeypatch):
    monkeypatch.setattr(settings, "encryption_key", Fernet.generate_key().decode())
    other_id = uuid4()
    db_session.add(User(id=other_id, email=f"{other_id}@other.test", password_hash="x"))
    db_session.add(ApiKey(
        user_id=other_id,
        provider="openai",
        encrypted_key=encrypt_api_key("sk-other-secret"),
        key_prefix="sk-other",
        is_active=True,
    ))
    await db_session.commit()

    # test_user has no key stored for openai, so it must NOT see the other user's key.
    res = await client.get("/api/keys/openai/key")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_provider_key_no_key(client: AsyncClient, test_user: User):
    res = await client.get("/api/keys/openai/key")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_provider_key_invalid_provider(client: AsyncClient):
    res = await client.get("/api/keys/bogus/key")
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_key_test_requires_auth():
    """The key-test endpoint forwards user-supplied keys to third-party
    providers from the server IP, so it must not be an open, unauthenticated
    proxy."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/keys/test",
            json={"provider": "deepseek", "api_key": "sk-test-1234567890"},
        )
    assert res.status_code == 401
