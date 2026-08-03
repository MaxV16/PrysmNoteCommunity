"""Tests for the EE integrations (Google Calendar / GitHub) router.

Verifies the OAuth surface is auth-gated (401 without an authenticated user) and
degrades gracefully when the provider is not configured (no client id/secret in
the env), which is the default .env state.
"""
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_integration_connect_reports_not_configured(client: AsyncClient):
    # Authed, but the server has no GitHub/Google client secrets in CI/local .env.
    response = await client.get("/api/ee/github/connect")
    assert response.status_code == 400
    assert "not configured" in response.json()["detail"]

    response = await client.get("/api/ee/calendar/connect")
    assert response.status_code == 400
    assert "not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_integration_status_connected_false(client: AsyncClient):
    gh = await client.get("/api/ee/github/status")
    assert gh.status_code == 200
    assert gh.json()["connected"] is False

    gc = await client.get("/api/ee/calendar/status")
    assert gc.status_code == 200
    assert gc.json()["connected"] is False


@pytest.mark.asyncio
async def test_integration_disconnect_idempotent(client: AsyncClient):
    gh = await client.post("/api/ee/github/disconnect")
    assert gh.status_code == 200
    assert gh.json()["connected"] is False

    gc = await client.post("/api/ee/calendar/disconnect")
    assert gc.status_code == 200


@pytest.mark.asyncio
async def test_integration_status_requires_auth(auth_client: AsyncClient):
    # auth_client uses the real auth dependency, so unauthenticated = 401.
    assert (await auth_client.get("/api/ee/github/status")).status_code == 401
    assert (await auth_client.get("/api/ee/calendar/status")).status_code == 401
