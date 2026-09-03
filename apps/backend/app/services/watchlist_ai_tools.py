"""Watchlist (Shows & Movies) tools surfaced to the in-app AI agent.

This is the reference pattern for core (non-EE) feature tool modules: it exports
the same triple the EE tool modules use (`_SYSTEM_NOTE`, `_TOOL_DEFINITIONS`,
`_TOOL_HANDLERS`) but unconditionally, so ``ai_service.py`` extends its toolset
with these definitions for every AI user. Handlers take ``(args, user_id,
session)`` and return JSON-serializable dicts; the session is already RLS-keyed
by ``get_current_user``.
"""
from __future__ import annotations

from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy import select

from app.models.watchlist import WatchlistItem
from app.services import tmdb_service, watchlist_service
from app.utils.uuid_helpers import parse_uuid

VALID_STATUSES = {"plan_to_watch", "watching", "watched"}
VALID_MEDIA_TYPES = {"movie", "tv"}
SEARCH_RESULT_CAP = 8


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _clean_status(value: Any) -> str | None:
    status = str(value or "")
    if status in VALID_STATUSES:
        return status
    return None


def _rating(args: dict, key: str = "rating") -> int | None:
    value = args.get(key)
    if value is None:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if 1 <= value <= 10 else None


# ---------------------------------------------------------------------------
# System note (appended to the agent's system prompt)
# ---------------------------------------------------------------------------

WATCHLIST_SYSTEM_NOTE = (
    "WATCHLIST: You can manage the user's Shows & Movies watchlist (TMDB-backed movie/TV "
    "tracking). Decode watchlist intent in plain language: \"add X to my watchlist\" -> "
    "search_titles to find the exact title, then add_watchlist_item with the tmdb_id and "
    "media_type returned; \"what am I watching / what's on my list\" -> list_watchlist "
    "(optionally filtering by status plan_to_watch / watching / watched); \"mark Severance "
    "watched\" -> update_watchlist_item with status=\"watched\"; \"rate it 9\" -> "
    "update_watchlist_item with rating 9; \"remove X from my watchlist\" is DESTRUCTIVE - "
    "do NOT remove in the same turn. First list the exact item you will remove, then ask "
    "the user to confirm, and only call remove_watchlist_item in a LATER turn once they "
    "explicitly confirm. Never claim an add/update/remove succeeded unless the tool "
    "returned the matching success flag (created/updated/deleted)."
)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

WATCHLIST_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_titles",
            "description": "Search movies and TV shows by title (TMDB multi-search). Returns the top matches with tmdb_id, media_type (movie or tv), title, release_year and poster_url. Use this FIRST whenever the user wants to add something to their watchlist so you can pass the correct tmdb_id and media_type to add_watchlist_item.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "title to search for"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_watchlist",
            "description": "List the user's watchlist items (optionally filtered by status: plan_to_watch, watching, watched). Each item has id, title, media_type, status, rating, notes and poster_url.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["plan_to_watch", "watching", "watched"]},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_watchlist_item",
            "description": "Add a movie or TV show to the user's watchlist. Pass tmdb_id and media_type from search_titles; title/release_year/poster_path are optional manual fallbacks. status defaults to plan_to_watch. rating is 1-10. Returns the serialized item or an error if it is already on the watchlist.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tmdb_id": {"type": "integer"},
                    "media_type": {"type": "string", "enum": ["movie", "tv"]},
                    "title": {"type": "string"},
                    "release_year": {"type": "integer"},
                    "poster_path": {"type": "string"},
                    "status": {"type": "string", "enum": ["plan_to_watch", "watching", "watched"]},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 10},
                    "notes": {"type": "string"},
                },
                "required": ["tmdb_id", "media_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_watchlist_item",
            "description": "Update an existing watchlist item (status, rating 1-10, notes, watched_at YYYY-MM-DD). Use when the user marks something watched, rates it, or edits its notes. Only include fields that changed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "status": {"type": "string", "enum": ["plan_to_watch", "watching", "watched"]},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 10},
                    "notes": {"type": "string"},
                    "watched_at": {"type": "string", "description": "YYYY-MM-DD"},
                },
                "required": ["item_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_watchlist_item",
            "description": "Permanently remove an item from the user's watchlist. DESTRUCTIVE: require explicit user confirmation before calling. Never remove an item the user merely said they watched - update its status to watched instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                },
                "required": ["item_id"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Handlers: (args, user_id, session) -> dict
# ---------------------------------------------------------------------------


async def _search_titles(args: dict, user_id: str, session) -> dict:
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "query is required."}
    results = await tmdb_service.search_multi(query)
    capped = [
        {
            "tmdb_id": r["tmdb_id"],
            "media_type": r["media_type"],
            "title": r["title"],
            "release_year": r.get("release_year"),
            "poster_url": tmdb_service.poster_url(r.get("poster_path")),
        }
        for r in results[:SEARCH_RESULT_CAP]
    ]
    return {"count": len(capped), "results": capped}


async def _list_watchlist(args: dict, user_id: str, session) -> dict:
    status = _clean_status(args.get("status"))
    stmt = select(WatchlistItem).where(WatchlistItem.user_id == UUID(user_id))
    if status:
        stmt = stmt.where(WatchlistItem.status == status)
    stmt = stmt.order_by(WatchlistItem.created_at.desc())
    result = await session.execute(stmt)
    items = result.scalars().all()
    return {"count": len(items), "items": [watchlist_service.serialize(i) for i in items]}


async def _add_watchlist_item(args: dict, user_id: str, session) -> dict:
    media_type = str(args.get("media_type") or "").strip()
    if media_type not in VALID_MEDIA_TYPES:
        return {"error": "media_type must be movie or tv"}
    try:
        tmdb_id = int(args.get("tmdb_id"))
    except (TypeError, ValueError):
        return {"error": "tmdb_id is required and must be an integer"}
    status = _clean_status(args.get("status")) or "plan_to_watch"
    rating = _rating(args)

    duplicate = await session.execute(
        select(WatchlistItem.id).where(
            WatchlistItem.user_id == UUID(user_id),
            WatchlistItem.tmdb_id == tmdb_id,
        )
    )
    if duplicate.scalar_one_or_none():
        return {"error": "Already on your watchlist", "code": 409}

    item = WatchlistItem(
        user_id=UUID(user_id),
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=str(args.get("title") or "").strip(),
        poster_path=args.get("poster_path"),
        release_year=args.get("release_year"),
        status=status,
        rating=rating,
        notes=args.get("notes"),
    )
    session.add(item)
    await session.flush()
    await watchlist_service.fetch_and_store_metadata(session, item)
    if not item.title.strip():
        await session.rollback()
        return {"error": "Title is required (TMDB lookup unavailable)"}
    await session.flush()
    return {"created": True, "item": watchlist_service.serialize(item)}


async def _update_watchlist_item(args: dict, user_id: str, session) -> dict:
    item_uuid = parse_uuid(str(args.get("item_id") or ""))
    if item_uuid is None:
        return {"error": "Invalid item_id format"}
    result = await session.execute(
        select(WatchlistItem).where(WatchlistItem.id == item_uuid, WatchlistItem.user_id == UUID(user_id))
    )
    item = result.scalar_one_or_none()
    if not item:
        return {"error": "Watchlist item not found"}

    status = _clean_status(args.get("status"))
    if "status" in args and status is None:
        return {"error": "Invalid status"}
    if status:
        item.status = status
    if "rating" in args:
        rating = _rating(args)
        if rating is None:
            return {"error": "rating must be an integer between 1 and 10"}
        item.rating = rating
    if "notes" in args:
        item.notes = args.get("notes")
    if "watched_at" in args:
        raw = args.get("watched_at")
        if raw:
            parsed = _parse_date(raw)
            if parsed is None:
                return {"error": "watched_at must be YYYY-MM-DD"}
            item.watched_at = parsed
        else:
            item.watched_at = None
    await session.flush()
    return {"updated": True, "item": watchlist_service.serialize(item)}


async def _remove_watchlist_item(args: dict, user_id: str, session) -> dict:
    item_uuid = parse_uuid(str(args.get("item_id") or ""))
    if item_uuid is None:
        return {"error": "Invalid item_id format"}
    result = await session.execute(
        select(WatchlistItem).where(WatchlistItem.id == item_uuid, WatchlistItem.user_id == UUID(user_id))
    )
    item = result.scalar_one_or_none()
    if not item:
        return {"error": "Watchlist item not found"}
    await session.delete(item)
    await session.flush()
    return {"deleted": True, "item_id": str(item.id)}


WATCHLIST_TOOL_HANDLERS = {
    "search_titles": _search_titles,
    "list_watchlist": _list_watchlist,
    "add_watchlist_item": _add_watchlist_item,
    "update_watchlist_item": _update_watchlist_item,
    "remove_watchlist_item": _remove_watchlist_item,
}
