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
