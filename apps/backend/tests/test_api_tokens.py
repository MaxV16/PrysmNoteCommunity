"""Tests for the core personal access token service/router and the base MCP server.

The MCP server ships in open core, so its token plumbing and base tool registry
are covered here. SQLite-portable (the EE suite runs on in-memory SQLite).
"""
import uuid

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from app.models.api_token import ApiToken
from app.services import api_tokens_service as svc


async def test_create_token_format(db_session, ai_user):
    raw, row = await svc.create_token(db_session, ai_user, "My token")

    assert raw.startswith(svc.TOKEN_PREFIX)
    assert len(raw) > len(svc.TOKEN_PREFIX) + 40
    assert row.prefix == raw[:8]
    assert row.name == "My token"
    assert row.token_hash == svc.hash_token(raw)
    assert len(row.token_hash) == 64
    assert row.revoked_at is None


async def test_create_token_default_name_and_truncation(db_session, ai_user):
    _, row = await svc.create_token(db_session, ai_user, "")
    assert row.name == "MCP token"

    _, long_row = await svc.create_token(db_session, ai_user, "x" * 200)
    assert len(long_row.name) == 80


async def test_lookup_token(db_session, ai_user):
    raw, row = await svc.create_token(db_session, ai_user, "t")
    await db_session.flush()

    found = await svc.lookup_token(db_session, raw)
    assert isinstance(found, ApiToken)
    assert found.id == row.id

    assert await svc.lookup_token(db_session, "prysm_live_unknown") is None
    assert await svc.lookup_token(db_session, "not-a-token") is None
    assert await svc.lookup_token(db_session, "") is None


async def test_lookup_token_returns_none_when_revoked(db_session, ai_user):
    raw, row = await svc.create_token(db_session, ai_user, "t")
    await db_session.flush()

    await svc.revoke_token(db_session, row.id, ai_user)
    await db_session.flush()

    assert await svc.lookup_token(db_session, raw) is None


async def test_token_public_shape(db_session, ai_user):
    _, row = await svc.create_token(db_session, ai_user, "t")
    await db_session.flush()

    payload = svc.token_public(row)
    assert set(payload) == {
        "id",
        "name",
        "prefix",
        "created_at",
        "last_used_at",
        "revoked_at",
    }
    assert payload["id"] == str(row.id)
    assert payload["revoked_at"] is None
    assert "token_hash" not in payload


async def test_list_tokens(db_session, ai_user):
    await svc.create_token(db_session, ai_user, "first")
    await svc.create_token(db_session, ai_user, "second")
    await db_session.flush()

    rows = await svc.list_tokens(db_session, ai_user)
    assert {r.name for r in rows} == {"first", "second"}


async def test_revoke_token_unknown_raises_404(db_session, ai_user):
    with pytest.raises(HTTPException) as exc:
        await svc.revoke_token(db_session, uuid.uuid4(), ai_user)
    assert exc.value.status_code == 404


async def test_lookup_token_system_returns_and_stamps(db_session, ai_user):
    """Works on both lookup paths: the caller session on SQLite (tests) and a
    BYPASSRLS system session on Postgres (production)."""
    raw, _ = await svc.create_token(db_session, ai_user, "t")
    # Commit first: on Postgres the lookup opens a separate system session, so an
    # uncommitted row would be invisible and the assertion would fail for the
    # wrong reason.
    await db_session.commit()

    found = await svc.lookup_token_system(raw, db_session)
    assert found is not None
    assert found.last_used_at is not None


async def test_router_create_list_revoke(client: AsyncClient):
    created = await client.post("/api/tokens", json={"name": "MCP token"})
    assert created.status_code == 201
    body = created.json()
    assert body["plaintext"].startswith(svc.TOKEN_PREFIX)
    assert body["prefix"] == body["plaintext"][:8]
    token_id = body["id"]

    listed = await client.get("/api/tokens")
    assert listed.status_code == 200
    tokens = listed.json()["tokens"]
    assert len(tokens) == 1
    assert tokens[0]["id"] == token_id
    assert "plaintext" not in tokens[0]

    deleted = await client.delete(f"/api/tokens/{token_id}")
    assert deleted.status_code == 200
    assert deleted.json()["revoked"] is True


async def test_router_delete_unknown_token_404(client: AsyncClient):
    resp = await client.delete(f"/api/tokens/{uuid.uuid4()}")
    assert resp.status_code == 404


async def test_router_create_is_rate_limited(client: AsyncClient):
    statuses = []
    for _ in range(11):
        resp = await client.post("/api/tokens", json={"name": "spam"})
        statuses.append(resp.status_code)

    assert statuses.count(201) == 10
    assert statuses[10] == 429


async def test_base_mcp_tools_registered():
    from app.database import async_session_factory
    from app.services.mcp_server import _build_mcp_server

    mcp = _build_mcp_server(async_session_factory)
    tools = await mcp.list_tools()
    names = {tool.name for tool in tools}

    expected = {
        "search_tasks",
        "create_task",
        "get_task_details",
        "update_task",
        "complete_task",
        "delete_task",
        "list_tasks_by_date_range",
        "check_calendar",
        "list_tags",
        "add_tag_to_task",
        "search_titles",
        "list_watchlist",
        "add_watchlist_item",
        "update_watchlist_item",
        "remove_watchlist_item",
        "list_habits",
        "create_habit",
        "update_habit",
        "delete_habit",
        "toggle_habit_log",
        "get_habit_logs",
    }
    assert expected <= names
