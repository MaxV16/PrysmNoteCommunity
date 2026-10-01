"""Passkey (WebAuthn) endpoint tests.

The crypto verification is exercised by the py_webauthn library itself; these
tests cover our request/response contract, the challenge-cookie binding, RLS
ownership, rate limiting, CSRF and the desktop one-time deep link. The verify
helpers are monkeypatched so no real authenticator is needed.
"""
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest

from app.config import settings
from app.models.passkey import Passkey
from app.models.user import User
from app.routers import passkeys as passkeys_module
from webauthn.helpers import bytes_to_base64url

RAW_CREDENTIAL_ID = b"\x01\x02\x03\x04"
STORED_CREDENTIAL_ID = bytes_to_base64url(RAW_CREDENTIAL_ID)


class _FakeRegistration:
    credential_id = RAW_CREDENTIAL_ID
    credential_public_key = b"fake-public-key-bytes"
    sign_count = 0
    aaguid = "00000000-0000-0000-0000-000000000000"


class _FakeAuthentication:
    credential_id = RAW_CREDENTIAL_ID
    new_sign_count = 1


@pytest.mark.asyncio
async def test_register_options_shape_and_challenge_cookie(client):
    r = await client.post("/api/auth/passkey/register/options")
    assert r.status_code == 200
    body = r.json()
    assert body["challenge"]
    assert body["rp"]["name"] == "Prysm Note"
    assert body["user"]["name"]
    assert body["pubKeyCredParams"]
    # Discoverable credential + user verification are required for the
    # username-less "Sign in with a passkey" flow.
    assert body["authenticatorSelection"]["residentKey"] == "required"
    assert body["authenticatorSelection"]["userVerification"] == "required"
    assert "webauthn_challenge" in r.headers.get("set-cookie", "")


@pytest.mark.asyncio
async def test_register_verify_happy_path(client, db_session, monkeypatch):
    monkeypatch.setattr(passkeys_module, "verify_registration_response", lambda **kw: _FakeRegistration())
    await client.post("/api/auth/passkey/register/options")
    r = await client.post(
        "/api/auth/passkey/register/verify",
        json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {"transports": ["internal"]}}, "name": "My Mac"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "My Mac"

    stored = (await db_session.execute(Passkey.__table__.select())).mappings().all()
    assert len(stored) == 1
    assert stored[0]["credential_id"] == STORED_CREDENTIAL_ID
    assert stored[0]["transports"] == "internal"


@pytest.mark.asyncio
async def test_register_verify_without_challenge_cookie_is_400(client):
    client.cookies.clear()
    r = await client.post(
        "/api/auth/passkey/register/verify",
        json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {}}},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_login_options_shape(client):
    r = await client.post("/api/auth/passkey/login/options")
    assert r.status_code == 200
    body = r.json()
    assert body["challenge"]
    # Username-less flow: the client offers no credential allow-list.
    assert body["allowCredentials"] == []
    assert body["userVerification"] == "required"
    assert "webauthn_challenge" in r.headers.get("set-cookie", "")


async def _register_passkey(client, db_session, monkeypatch):
    monkeypatch.setattr(passkeys_module, "verify_registration_response", lambda **kw: _FakeRegistration())
    await client.post("/api/auth/passkey/register/options")
    r = await client.post(
        "/api/auth/passkey/register/verify",
        json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {}}},
    )
    assert r.status_code == 200, r.text
    return (await db_session.execute(Passkey.__table__.select())).mappings().one()


@pytest.mark.asyncio
async def test_login_verify_sets_session_cookies(client, db_session, monkeypatch):
    await _register_passkey(client, db_session, monkeypatch)
    monkeypatch.setattr(passkeys_module, "verify_authentication_response", lambda **kw: _FakeAuthentication())

    await client.post("/api/auth/passkey/login/options")
    r = await client.post(
        "/api/auth/passkey/login/verify",
        json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {}}},
    )
    assert r.status_code == 200, r.text
    set_cookie = r.headers.get("set-cookie", "")
    assert "access_token" in set_cookie
    assert "refresh_token" in set_cookie
    assert r.json()["email"]


@pytest.mark.asyncio
async def test_login_is_rate_limited(client, monkeypatch):
    from app.utils.ratelimit import RateLimiter

    monkeypatch.setattr(passkeys_module, "_passkey_limiter", RateLimiter("rl:passkey:test"))
    monkeypatch.setattr(passkeys_module, "LOGIN_LIMIT", 0)
    r = await client.post("/api/auth/passkey/login/options")
    assert r.status_code == 429


@pytest.mark.asyncio
async def test_desktop_login_returns_single_use_deep_link(client, db_session, monkeypatch):
    await _register_passkey(client, db_session, monkeypatch)
    monkeypatch.setattr(passkeys_module, "verify_authentication_response", lambda **kw: _FakeAuthentication())

    await client.post("/api/auth/passkey/login/options")
    r = await client.post(
        "/api/auth/passkey/login/verify",
        json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {}}, "desktop_nonce": "nonce-abc"},
    )
    assert r.status_code == 200, r.text
    redirect = r.json()["redirect"]
    assert redirect.startswith("prysmnote://oauth/callback?code=")
    assert "nonce=nonce-abc" in redirect
    # No session cookies in the system browser.
    assert "access_token" not in r.headers.get("set-cookie", "")

    code = parse_qs(urlparse(redirect).query)["code"][0]
    exchange = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert exchange.status_code == 307
    assert "access_token" in exchange.headers.get("set-cookie", "")
    # The code is single-use.
    replay = await client.get(f"/api/auth/mobile/exchange?code={code}")
    assert replay.status_code == 400


@pytest.mark.asyncio
async def test_second_user_cannot_see_or_manage_another_passkey(client, db_session):
    other = User(id=uuid4(), email=f"other-{uuid4()}@example.test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    if db_session.get_bind().dialect.name == "postgresql":
        from app.utils.rls import set_rls_user_id

        await set_rls_user_id(db_session, other.id)
    passkey = Passkey(
        user_id=other.id,
        credential_id=f"other-{uuid4()}",
        public_key=b"other-key",
        sign_count=0,
    )
    db_session.add(passkey)
    await db_session.commit()
    passkey_id = passkey.id

    listed = await client.get("/api/auth/passkey")
    assert listed.status_code == 200
    assert all(p["id"] != str(passkey_id) for p in listed.json())

    rename = await client.patch(f"/api/auth/passkey/{passkey_id}", json={"name": "hijacked"})
    assert rename.status_code == 404

    removed = await client.delete(f"/api/auth/passkey/{passkey_id}")
    assert removed.status_code == 404


@pytest.mark.asyncio
async def test_register_verify_requires_csrf(client):
    original = settings.csrf_enabled
    settings.csrf_enabled = True
    try:
        r = await client.post(
            "/api/auth/passkey/register/verify",
            json={"credential": {"rawId": STORED_CREDENTIAL_ID, "response": {}}},
        )
        assert r.status_code == 403
    finally:
        settings.csrf_enabled = original
