import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_login_sets_non_secure_cookies_on_localhost(client: AsyncClient):
    response = await client.post(
        "/api/auth/login",
        json={"email": "cookie@example.com", "password": "password123"},
    )

    assert response.status_code == 200
    set_cookie = response.headers.get("set-cookie", "")
    assert "Secure" not in set_cookie
