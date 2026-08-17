import pytest
from httpx import AsyncClient


async def _with_csrf_enabled(settings_module, on: bool):
    from app.config import settings

    settings.csrf_enabled = on
    yield
    settings.csrf_enabled = False


@pytest.mark.asyncio
async def test_post_without_csrf_token_is_rejected(auth_client: AsyncClient):
    """When CSRF is enabled, an unsafe request without the X-CSRF-Token header
    must be rejected with 403 — the double-submit guard."""
    from app.config import settings

    settings.csrf_enabled = True
    try:
        response = await auth_client.post("/api/tasks/", json={"title": "No CSRF"})
        assert response.status_code == 403
        assert "CSRF" in response.json()["detail"]
    finally:
        settings.csrf_enabled = False


@pytest.mark.asyncio
async def test_post_with_matching_csrf_token_succeeds(auth_client: AsyncClient):
    """GET sets the csrf_token cookie; echoing it in X-CSRF-Token on a POST
    passes the double-submit check (token must match the cookie)."""
    from app.config import settings

    settings.csrf_enabled = True
    try:
        # Prime the cookie via a safe request (middleware sets it as a side effect).
        me = await auth_client.get("/api/auth/me")
        assert me.status_code == 401  # logged out is fine; cookie was set
        cookie = auth_client.cookies.get("csrf_token")
        assert cookie, "expected a csrf_token cookie after a safe GET"

        # Log in (exempt) so the task POST is authenticated.
        await auth_client.post("/api/auth/register", json={
            "email": "csrfuser@example.com",
            "password": "password123",
        })
        response = await auth_client.post(
            "/api/tasks/",
            json={"title": "With CSRF"},
            headers={"X-CSRF-Token": cookie},
        )
        assert response.status_code == 200, response.text
        assert response.json()["title"] == "With CSRF"
    finally:
        settings.csrf_enabled = False


@pytest.mark.asyncio
async def test_post_with_mismatched_csrf_token_is_rejected(auth_client: AsyncClient):
    from app.config import settings

    settings.csrf_enabled = True
    try:
        await auth_client.get("/api/auth/me")
        await auth_client.post("/api/auth/register", json={
            "email": "csrfmismatch@example.com",
            "password": "password123",
        })
        response = await auth_client.post(
            "/api/tasks/",
            json={"title": "Bad CSRF"},
            headers={"X-CSRF-Token": "wrong-token-value"},
        )
        assert response.status_code == 403
    finally:
        settings.csrf_enabled = False
