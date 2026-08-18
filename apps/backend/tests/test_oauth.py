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


@pytest.mark.asyncio
async def test_github_code_on_google_callback_is_exchanged_with_github(client, monkeypatch):
    # GitHub's OAuth app uses the SAME callback URL as Google (the "google" in
    # the path is a quirk), so a GitHub-style code (20 lowercase hex chars)
    # arriving at /google/callback must be exchanged with GitHub, not Google.
    # Regression: GitHub codes were misrouted to Google's token endpoint and
    # always failed with "Sign-in with that provider failed".
    exchanged = {}
    github_code = "a1b2c3d4e5f6a7b8c9d0"

    async def fake_exchange_github(code):
        exchanged["code"] = code
        return {"email": "maxv16@example.com", "name": "Max V16"}

    monkeypatch.setattr(oauth_module, "_exchange_github", fake_exchange_github)
    monkeypatch.setattr(oauth_module, "_exchange_google", lambda code: None)
    client.cookies.set("oauth_state", "abc123")

    r = await client.get(
        "/api/auth/oauth/google/callback",
        params={"code": github_code, "state": "abc123"},
    )
    assert r.status_code in (302, 307)
    assert exchanged.get("code") == github_code
    # Successful exchange redirects into the app (not to a failure page).
    assert "error=" not in r.headers.get("location", "")


@pytest.mark.asyncio
async def test_google_code_on_google_callback_is_exchanged_with_google(client, monkeypatch):
    # A genuine Google code (contains '/', e.g. 4/0A...) must stay on Google.
    exchanged = {}
    google_code = "4/0ATsMZqCquQWD4uqhj_tvTLt8U92RQRXgUN20SEdFO61P6B4l5QqoaIcgQpCHd1LEdgpYEg"

    async def fake_exchange_google(code):
        exchanged["code"] = code
        return {"email": "user@gmail.com", "name": "G", "email_verified": True}

    monkeypatch.setattr(oauth_module, "_exchange_google", fake_exchange_google)
    client.cookies.set("oauth_state", "abc123")

    r = await client.get(
        "/api/auth/oauth/google/callback",
        params={"code": google_code, "state": "abc123"},
    )
    assert r.status_code in (302, 307)
    assert exchanged.get("code") == google_code
    assert "error=" not in r.headers.get("location", "")
