import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_register(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/register", json={
        "email": "newuser@example.com",
        "password": "password123",
        "display_name": "New User",
    })
    assert response.status_code == 200
    data = response.json()
    assert "id" in data
    assert data["email"] == "newuser@example.com"
    assert data["display_name"] == "New User"

    # Verify cookies are set with correct path
    cookies = response.cookies
    assert "access_token" in cookies
    assert "refresh_token" in cookies


@pytest.mark.asyncio
async def test_register_invalid_email(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/register", json={
        "email": "notanemail",
        "password": "password123",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_register_short_password(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/register", json={
        "email": "test@example.com",
        "password": "short",
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_register_long_password(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/register", json={
        "email": "test@example.com",
        "password": "x" * 129,
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_register_password_over_72_bytes_rejected(auth_client: AsyncClient):
    # bcrypt only uses the first 72 bytes; longer inputs would hash
    # identically, so they must be rejected outright.
    response = await auth_client.post("/api/auth/register", json={
        "email": "over72@example.com",
        "password": "x" * 73,
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_register_duplicate_email(auth_client: AsyncClient):
    await auth_client.post("/api/auth/register", json={
        "email": "dup@example.com",
        "password": "password123",
    })
    response = await auth_client.post("/api/auth/register", json={
        "email": "dup@example.com",
        "password": "password456",
    })
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_login(auth_client: AsyncClient):
    await auth_client.post("/api/auth/register", json={
        "email": "login@example.com",
        "password": "password123",
    })
    response = await auth_client.post("/api/auth/login", json={
        "email": "login@example.com",
        "password": "password123",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["email"] == "login@example.com"
    assert "access_token" in response.cookies
    assert "refresh_token" in response.cookies
    # Verify cookie path is "/" for both
    for cookie_name in ("access_token", "refresh_token"):
        cookie_header = response.headers.get("set-cookie", "")
        assert cookie_name in cookie_header


@pytest.mark.asyncio
async def test_login_wrong_password(auth_client: AsyncClient):
    await auth_client.post("/api/auth/register", json={
        "email": "wrong@example.com",
        "password": "password123",
    })
    response = await auth_client.post("/api/auth/login", json={
        "email": "wrong@example.com",
        "password": "wrongpass",
    })
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_login_nonexistent_user(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/login", json={
        "email": "nobody@example.com",
        "password": "password123",
    })
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_refresh_token(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "refresh@example.com",
        "password": "password123",
    })
    refresh_token = reg.cookies.get("refresh_token")

    response = await auth_client.post("/api/auth/refresh", json={
        "refresh_token": refresh_token,
    })
    assert response.status_code == 200
    assert "access_token" in response.cookies
    assert "refresh_token" in response.cookies


@pytest.mark.asyncio
async def test_refresh_from_cookie(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "cookie_refresh@example.com",
        "password": "password123",
    })
    cookies = {"refresh_token": reg.cookies.get("refresh_token")}
    response = await auth_client.post("/api/auth/refresh", json={}, cookies=cookies)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_refresh_invalid_token(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/refresh", json={
        "refresh_token": "invalid_token_here",
    })
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_refresh_no_token(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/refresh", json={})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_get_me(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "me@example.com",
        "password": "password123",
        "display_name": "Me",
    })
    token = reg.cookies.get("access_token")
    headers = {"Authorization": f"Bearer {token}"}

    response = await auth_client.get("/api/auth/me", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["email"] == "me@example.com"
    assert data["display_name"] == "Me"
    assert "created_at" in data


@pytest.mark.asyncio
async def test_get_me_unauthorized(auth_client: AsyncClient):
    response = await auth_client.get("/api/auth/me")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_update_me(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "update_me@example.com",
        "password": "password123",
    })
    token = reg.cookies.get("access_token")
    headers = {"Authorization": f"Bearer {token}"}

    response = await auth_client.patch("/api/auth/me", json={
        "display_name": "Updated Name",
    }, headers=headers)
    assert response.status_code == 200
    assert response.json()["display_name"] == "Updated Name"


@pytest.mark.asyncio
async def test_logout(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "logout@example.com",
        "password": "password123",
    })
    token = reg.cookies.get("access_token")
    headers = {"Authorization": f"Bearer {token}"}

    response = await auth_client.post("/api/auth/logout", headers=headers)
    assert response.status_code == 200

    # After logout, /me should fail
    me = await auth_client.get("/api/auth/me", headers=headers)
    assert me.status_code == 401


@pytest.mark.asyncio
async def test_ip_rate_limit_block(auth_client: AsyncClient):
    # Attempt login with wrong password 10 times
    for _ in range(12):
        await auth_client.post("/api/auth/login", json={
            "email": "ratelimit@example.com",
            "password": "wrong",
        })
    # Next should be blocked
    response = await auth_client.post("/api/auth/login", json={
        "email": "ratelimit@example.com",
        "password": "stillwrong",
    })
    assert response.status_code == 429


def test_blocklist_expires_over_time(monkeypatch):
    """The IP blocklist is time-based and self-pruning, never permanent."""
    import time as _time

    import app.routers.auth as auth_mod

    # Isolate the module state for this test.
    auth_mod._IP_BLOCKLIST = {}
    auth_mod._FAILED_LOGINS = {}

    # Drive time deterministically.
    fake_now = 1_700_000_000.0
    monkeypatch.setattr(auth_mod.time, "time", lambda: fake_now)

    # Simulate 10 failed logins -> IP becomes blocked.
    for _ in range(10):
        auth_mod._track_failed_login("203.0.113.7")
    assert auth_mod._is_blocked("203.0.113.7") is True

    # Advance past the block duration -> the IP must be unblocked and pruned.
    fake_now += auth_mod._BLOCK_DURATION + 1
    assert auth_mod._is_blocked("203.0.113.7") is False
    assert "203.0.113.7" not in auth_mod._IP_BLOCKLIST

    # Restore module state.
    auth_mod._IP_BLOCKLIST = {}
    auth_mod._FAILED_LOGINS = {}


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_not_revealing(auth_client: AsyncClient):
    """An unknown email returns the same 200 'sent' response (no enumeration)."""
    response = await auth_client.post("/api/auth/forgot-password", json={
        "email": "nobody@example.com",
    })
    assert response.status_code == 200
    assert response.json() == {"status": "sent"}


@pytest.mark.asyncio
async def test_forgot_password_for_existing_user(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "resetme@example.com",
        "password": "password123",
    })
    assert reg.status_code == 200
    response = await auth_client.post("/api/auth/forgot-password", json={
        "email": "resetme@example.com",
    })
    assert response.status_code == 200
    assert response.json() == {"status": "sent"}


def _make_reset_token(user_id: str, minutes: int = 30) -> str:
    from datetime import datetime, timedelta, timezone
    from uuid import uuid4

    from jose import jwt

    from app.config import settings

    expires = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return jwt.encode(
        {"sub": user_id, "exp": expires, "type": "reset", "jti": str(uuid4())},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


@pytest.mark.asyncio
async def test_reset_password_happy_path(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "happypath@example.com",
        "password": "password123",
    })
    assert reg.status_code == 200
    user_id = reg.json()["id"]
    old_cookie = reg.cookies.get("access_token")

    # The pre-reset access token works before the reset.
    me = await auth_client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_cookie}"})
    assert me.status_code == 200

    token = _make_reset_token(user_id)
    reset = await auth_client.post("/api/auth/reset-password", json={
        "token": token,
        "new_password": "brandnewpass1",
    })
    assert reset.status_code == 200, reset.text

    # The old access token is invalidated (token_version bumped).
    me2 = await auth_client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_cookie}"})
    assert me2.status_code == 401

    # The reset token is one-time: reuse is rejected.
    reuse = await auth_client.post("/api/auth/reset-password", json={
        "token": token,
        "new_password": "anotherpass1",
    })
    assert reuse.status_code == 400

    # The new password logs in; the old one no longer does.
    old_login = await auth_client.post("/api/auth/login", json={
        "email": "happypath@example.com",
        "password": "password123",
    })
    assert old_login.status_code == 401
    new_login = await auth_client.post("/api/auth/login", json={
        "email": "happypath@example.com",
        "password": "brandnewpass1",
    })
    assert new_login.status_code == 200


@pytest.mark.asyncio
async def test_reset_password_invalid_token(auth_client: AsyncClient):
    response = await auth_client.post("/api/auth/reset-password", json={
        "token": "not-a-real-jwt",
        "new_password": "brandnewpass1",
    })
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_reset_password_expired_token(auth_client: AsyncClient):
    reg = await auth_client.post("/api/auth/register", json={
        "email": "expired@example.com",
        "password": "password123",
    })
    assert reg.status_code == 200
    token = _make_reset_token(reg.json()["id"], minutes=-5)
    response = await auth_client.post("/api/auth/reset-password", json={
        "token": token,
        "new_password": "brandnewpass1",
    })
    assert response.status_code == 400
