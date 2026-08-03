"""Tests for OAuth SSO login (endpoint + account creation)."""
import pytest
from httpx import AsyncClient

from app.config import settings
from app.routers import oauth as oauth_module


@pytest.mark.asyncio
async def test_oauth_start_redirects_to_login_when_unconfigured(client: AsyncClient):
    # With no Google/GitHub creds, start must not expose a provider URL; it
    # redirects to /login?error=sso_not_configured.
    orig_google = settings.google_client_id
    orig_github = settings.github_client_id
    settings.google_client_id = ""
    settings.github_client_id = ""
    try:
        r = await client.get("/api/auth/oauth/google/start")
        assert r.status_code == 302
        assert "sso_not_configured" in r.headers.get("location", "")
        assert "accounts.google.com" not in r.headers.get("location", "")

        r = await client.get("/api/auth/oauth/github/start")
        assert r.status_code == 302
        assert "sso_not_configured" in r.headers.get("location", "")
    finally:
        settings.google_client_id = orig_google
        settings.github_client_id = orig_github


@pytest.mark.asyncio
async def test_oauth_callback_bad_provider(client: AsyncClient):
    r = await client.get(
        "/api/auth/oauth/bad/callback",
        params={"code": "x", "state": "y"},
    )
    assert r.status_code in (302, 307)
    assert "unsupported_provider" in r.headers.get("location", "")


@pytest.mark.asyncio
async def test_oauth_callback_invalid_state(client: AsyncClient):
    # No oauth_state cookie set -> invalid state -> redirect to login error.
    r = await client.get(
        "/api/auth/oauth/google/callback",
        params={"code": "x", "state": "nope"},
    )
    assert r.status_code in (302, 307)
    assert "sso_invalid_state" in r.headers.get("location", "")


@pytest.mark.asyncio
async def test_oauth_getorcreate_user(db_session):
    from uuid import uuid4
    from app.models.user import User
    from sqlalchemy import select

    email = f"sso-{uuid4().hex}@example.com"

    # New user created with provider set and no password.
    user = await oauth_module._getorcreate_user(db_session, email, {"name": "Sam"}, "google")
    assert user.provider == "google"
    assert user.password_hash is None
    assert user.display_name == "Sam"

    # Calling again returns the same user (idempotent; provider already set).
    again = await oauth_module._getorcreate_user(db_session, email, {"name": "Sam"}, "google")
    assert again.id == user.id

    # A pre-existing email/password user gets linked (provider back-filled).
    pw_user = await oauth_module._getorcreate_user(db_session, "pwuser@example.com", {"name": "P"}, "github")
    assert pw_user.provider == "github"
