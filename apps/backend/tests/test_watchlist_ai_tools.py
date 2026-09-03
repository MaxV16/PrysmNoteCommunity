"""Tests for the in-app AI watchlist tools (core).

These tools are surfaced to the AI agent exactly like the inline core tools and
must never be EE-gated. Handlers run with the session RLS-keyed to the ``ai_user``
fixture, so cross-user isolation is asserted by seeding another user's item.
"""
import json
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.watchlist import WatchlistItem
from app.services import tmdb_service
from app.services.watchlist_ai_tools import (
    WATCHLIST_TOOL_HANDLERS,
    WATCHLIST_TOOL_DEFINITIONS,
)

TOOL_NAMES = {t["function"]["name"] for t in WATCHLIST_TOOL_DEFINITIONS}


def _stub_no_tmdb(monkeypatch):
    """Force the no-TMDB-key path so metadata fetch is a no-op."""
    monkeypatch.setattr(tmdb_service, "has_key", lambda: False)

    async def _empty_search(query):
        return []

    monkeypatch.setattr(tmdb_service, "search_multi", _empty_search)


async def _add_item(session, user_id, *, tmdb_id=1, title="Dune", media_type="movie", status="plan_to_watch"):
    item = WatchlistItem(
        user_id=user_id,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title,
        status=status,
    )
    session.add(item)
    await session.flush()
    return item


@pytest.mark.asyncio
async def test_tool_set_contains_five_watchlist_tools():
    assert TOOL_NAMES == {
        "search_titles",
        "list_watchlist",
        "add_watchlist_item",
        "update_watchlist_item",
        "remove_watchlist_item",
    }


@pytest.mark.asyncio
async def test_search_titles_returns_mapped_results(db_session: AsyncSession, ai_user, monkeypatch):
    async def fake_search_multi(query):
        return [
            {"tmdb_id": 438631, "media_type": "movie", "title": "Dune", "release_year": 2021, "poster_path": "/dune.jpg"},
            {"tmdb_id": 1396, "media_type": "tv", "title": "Breaking Bad", "release_year": 2008, "poster_path": None},
        ]

    monkeypatch.setattr(tmdb_service, "search_multi", fake_search_multi)
    payload = await WATCHLIST_TOOL_HANDLERS["search_titles"]({"query": "dune"}, str(ai_user), db_session)
    assert payload["count"] == 2
    assert payload["results"][0]["title"] == "Dune"
    assert payload["results"][0]["poster_url"].startswith("https://image.tmdb.org/t/p/w500")
    assert payload["results"][1]["media_type"] == "tv"


@pytest.mark.asyncio
async def test_search_titles_empty_without_key(db_session: AsyncSession, ai_user, monkeypatch):
    _stub_no_tmdb(monkeypatch)
    payload = await WATCHLIST_TOOL_HANDLERS["search_titles"]({"query": "dune"}, str(ai_user), db_session)
    assert payload["count"] == 0
    assert payload["results"] == []


@pytest.mark.asyncio
async def test_search_titles_requires_query(db_session: AsyncSession, ai_user):
    payload = await WATCHLIST_TOOL_HANDLERS["search_titles"]({}, str(ai_user), db_session)
    assert "error" in payload


@pytest.mark.asyncio
async def test_add_watchlist_item_and_dedupe(db_session: AsyncSession, ai_user, monkeypatch):
    _stub_no_tmdb(monkeypatch)
    payload = await WATCHLIST_TOOL_HANDLERS["add_watchlist_item"](
        {"tmdb_id": 438631, "media_type": "movie", "title": "Dune", "status": "watching", "rating": 9},
        str(ai_user),
        db_session,
    )
    assert payload["created"] is True
    item = payload["item"]
    assert item["title"] == "Dune"
    assert item["status"] == "watching"
    assert item["rating"] == 9

    dup = await WATCHLIST_TOOL_HANDLERS["add_watchlist_item"](
        {"tmdb_id": 438631, "media_type": "movie", "title": "Dune"},
        str(ai_user),
        db_session,
    )
    assert dup["code"] == 409
    assert "Already" in dup["error"]


@pytest.mark.asyncio
async def test_add_watchlist_item_validates_media_type(db_session: AsyncSession, ai_user, monkeypatch):
    _stub_no_tmdb(monkeypatch)
    payload = await WATCHLIST_TOOL_HANDLERS["add_watchlist_item"](
        {"tmdb_id": 1, "media_type": "book", "title": "X"},
        str(ai_user),
        db_session,
    )
    assert "error" in payload


@pytest.mark.asyncio
async def test_list_watchlist_filters_by_status(db_session: AsyncSession, ai_user):
    await _add_item(db_session, ai_user, tmdb_id=1, title="A", status="watching")
    await _add_item(db_session, ai_user, tmdb_id=2, title="B", status="watched")

    all_items = await WATCHLIST_TOOL_HANDLERS["list_watchlist"]({}, str(ai_user), db_session)
    assert all_items["count"] == 2

    watching = await WATCHLIST_TOOL_HANDLERS["list_watchlist"]({"status": "watching"}, str(ai_user), db_session)
    assert watching["count"] == 1
    assert watching["items"][0]["title"] == "A"


@pytest.mark.asyncio
async def test_update_watchlist_item_ownership_isolated(db_session: AsyncSession, ai_user):
    other = User(id=uuid4(), email=f"wla-{uuid4().hex[:8]}@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_item = await _add_item(db_session, other.id, tmdb_id=999, title="Secret")

    payload = await WATCHLIST_TOOL_HANDLERS["update_watchlist_item"](
        {"item_id": str(other_item.id), "status": "watched"},
        str(ai_user),
        db_session,
    )
    assert payload["error"] == "Watchlist item not found"


@pytest.mark.asyncio
async def test_update_watchlist_item_applies_fields(db_session: AsyncSession, ai_user):
    item = await _add_item(db_session, ai_user, tmdb_id=5, title="Severance")
    payload = await WATCHLIST_TOOL_HANDLERS["update_watchlist_item"](
        {"item_id": str(item.id), "status": "watched", "rating": 8, "notes": "loved it", "watched_at": "2026-08-30"},
        str(ai_user),
        db_session,
    )
    assert payload["updated"] is True
    data = payload["item"]
    assert data["status"] == "watched"
    assert data["rating"] == 8
    assert data["watched_at"] == "2026-08-30"


@pytest.mark.asyncio
async def test_update_watchlist_item_rejects_invalid_rating(db_session: AsyncSession, ai_user):
    item = await _add_item(db_session, ai_user, tmdb_id=6, title="X")
    payload = await WATCHLIST_TOOL_HANDLERS["update_watchlist_item"](
        {"item_id": str(item.id), "rating": 99},
        str(ai_user),
        db_session,
    )
    assert "error" in payload


@pytest.mark.asyncio
async def test_remove_watchlist_item_returns_deleted_flag(db_session: AsyncSession, ai_user):
    item = await _add_item(db_session, ai_user, tmdb_id=7, title="Delete Me")
    payload = await WATCHLIST_TOOL_HANDLERS["remove_watchlist_item"]({"item_id": str(item.id)}, str(ai_user), db_session)
    assert payload["deleted"] is True

    again = await WATCHLIST_TOOL_HANDLERS["remove_watchlist_item"]({"item_id": str(item.id)}, str(ai_user), db_session)
    assert again["error"] == "Watchlist item not found"


@pytest.mark.asyncio
async def test_invalid_args_return_graceful_error(db_session: AsyncSession, ai_user):
    payload = await WATCHLIST_TOOL_HANDLERS["update_watchlist_item"]({"item_id": "not-a-uuid"}, str(ai_user), db_session)
    assert payload["error"] == "Invalid item_id format"

    payload = await WATCHLIST_TOOL_HANDLERS["add_watchlist_item"]({"tmdb_id": "abc", "media_type": "movie"}, str(ai_user), db_session)
    assert "error" in payload
