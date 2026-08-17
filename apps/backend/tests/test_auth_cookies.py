import pytest
from fastapi import Request
from httpx import AsyncClient
from starlette.datastructures import Headers

from app.config import settings
from app.utils.auth_cookies import cookie_secure


@pytest.mark.asyncio
async def test_login_sets_non_secure_cookies_on_localhost(auth_client: AsyncClient):
    await auth_client.post(
        "/api/auth/register",
        json={"email": "cookie@example.com", "password": "password123"},
    )
    response = await auth_client.post(
        "/api/auth/login",
        json={"email": "cookie@example.com", "password": "password123"},
    )

    assert response.status_code == 200
    set_cookie = response.headers.get("set-cookie", "")
    assert "Secure" not in set_cookie


def _make_request(scheme: str, x_forwarded_proto: str | None) -> Request:
    headers = Headers()
    if x_forwarded_proto is not None:
        headers = Headers({"x-forwarded-proto": x_forwarded_proto})
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "scheme": scheme,
        "headers": headers.raw,
        "query_string": b"",
        "server": ("testserver", 80),
    }
    return Request(scope)


@pytest.mark.asyncio
async def test_cookie_secure_trusts_forwarded_proto_in_production(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")

    # Direct https is always secure regardless of proxy header.
    assert cookie_secure(_make_request("https", None)) is True
    # Behind the proxy: scheme stays http but X-Forwarded-Proto: https -> secure.
    assert cookie_secure(_make_request("http", "https")) is True
    # A clear/manually-set non-TLS forwarded proto -> not secure.
    assert cookie_secure(_make_request("http", "http")) is False
    # Missing forwarded proto behind proxy -> not secure (fail closed).
    assert cookie_secure(_make_request("http", None)) is False


@pytest.mark.asyncio
async def test_cookie_secure_never_trusts_forwarded_proto_in_dev(monkeypatch):
    monkeypatch.setattr(settings, "environment", "development")

    assert cookie_secure(_make_request("http", "https")) is False
    assert cookie_secure(_make_request("https", None)) is True
