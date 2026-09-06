"""Tests for OAuth SSO login (endpoint + account creation)."""
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from httpx import AsyncClient
from jose import jwt

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


@pytest.mark.asyncio
async def test_oauth_start_mobile_marks_state_cookie(client):
    # ?redirect=mobile prefixes the state cookie so the callback issues a mobile
    # one-time code instead of setting cookies in the system browser.
    orig_id, orig_secret = settings.google_client_id, settings.google_client_secret
    try:
        settings.google_client_id = "test-client"
        settings.google_client_secret = "test-secret"
        r = await client.get("/api/auth/oauth/google/start", params={"redirect": "mobile"})
        assert r.status_code == 302
        assert "accounts.google.com" in r.headers.get("location", "")
        cookie = r.cookies.get("oauth_state")
        assert cookie and cookie.startswith("mobile:")
    finally:
        settings.google_client_id = orig_id
        settings.google_client_secret = orig_secret

    # Web flow stays unprefixed.
    try:
        settings.google_client_id = "test-client"
        settings.google_client_secret = "test-secret"
        r = await client.get("/api/auth/oauth/google/start")
        assert r.status_code == 302
        cookie = r.cookies.get("oauth_state")
        assert cookie and not cookie.startswith("mobile:")
    finally:
        settings.google_client_id = orig_id
        settings.google_client_secret = orig_secret


@pytest.mark.asyncio
async def test_oauth_callback_mobile_redirects_to_deep_link_and_code_exchanges(client, monkeypatch):
    # Full mobile loop: callback (running in the system browser) issues a mobile
    # code and 307s to the custom deep link; the code then exchanges inside the
    # WebView, sets session cookies, and is single-use.
    async def fake_fetch_identity(provider, code):
        return {"email": "test@example.com", "name": "Test User", "email_verified": True}

    monkeypatch.setattr(oauth_module, "_fetch_identity", fake_fetch_identity)
    client.cookies.set("oauth_state", "mobile:abc123")

    r = await client.get(
        "/api/auth/oauth/google/callback",
        params={"code": "4/0fake", "state": "abc123"},
    )
    assert r.status_code in (302, 307)
    loc = r.headers.get("location", "")
    assert loc.startswith("com.prysmnote.app://oauth/client?code=")
    # No session cookies in the system browser.
    assert "access_token" not in r.headers.get("set-cookie", "")

    code = parse_qs(urlparse(loc).query)["code"][0]
    r2 = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert r2.status_code == 307
    assert "access_token" in r2.headers.get("set-cookie", "")
    assert r2.headers.get("location", "").startswith(settings.app_origin)

    r3 = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert r3.status_code == 400


@pytest.mark.asyncio
async def test_mobile_exchange_sets_cookies_and_is_single_use(client, test_user):
    code = oauth_module._create_mobile_code(test_user)
    r = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert r.status_code == 307
    assert "access_token" in r.headers.get("set-cookie", "")
    assert "refresh_token" in r.headers.get("set-cookie", "")
    assert r.headers.get("location", "").startswith(settings.app_origin)

    # Replay is rejected identically (single-use).
    r2 = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert r2.status_code == 400


@pytest.mark.asyncio
async def test_mobile_exchange_rejects_wrong_token_type(client, test_user):
    other = jwt.encode(
        {
            "sub": str(test_user.id),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            "type": "reset",
            "jti": str(uuid4()),
        },
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    r = await client.get(f"/api/auth/mobile/exchange?code={other}")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_mobile_exchange_rejects_expired_code(client, test_user):
    expired = jwt.encode(
        {
            "sub": str(test_user.id),
            "exp": datetime.now(timezone.utc) - timedelta(minutes=5),
            "type": "mobile_oauth",
            "jti": str(uuid4()),
        },
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    r = await client.get(f"/api/auth/mobile/exchange?code={expired}")
    assert r.status_code == 400
