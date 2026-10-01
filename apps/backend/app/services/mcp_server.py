"""Prysm Note MCP server (open core).

Exposes the core task, watchlist and habit tools to external AI apps (VS Code,
Cursor, Claude, etc.) over Streamable HTTP at ``/api/mcp``. Every request
authenticates with a bearer credential issued in Settings: a Personal Access
Token (``Authorization: Bearer prysm_live_...``) or, in the private build, an
MCP OAuth access JWT obtained through the "sign in via link" flow.

The middleware resolves the credential, enforces entitlement via the core
``is_premium`` hook (in the community build there is no entitlement provider, so
MCP is free; in the private build the premium plans gate it), and (for PATs)
stamps ``last_used_at``. Each tool opens its own session-factory session, sets
the RLS ``app.user_id`` (the MCP path has no JWT), runs the core service, and
commits, so every query stays row-scoped exactly like the REST API.

The user identity is carried from the middleware to the tool handlers via a
module-level ContextVar (both run in the same ASGI request task under the
Streamable HTTP transport, so contextvars propagate).

The private build extends this module through two marker blocks: an OAuth
access-token verifier and a hook that registers the premium tools (finance,
countdowns, quadrant, focus) from ``ee/``. OpenClaw AI *channel* tools stay out
of MCP (gateway polling architecture, not a client-facing toolset).
"""
from __future__ import annotations

import asyncio
import logging
from contextvars import ContextVar
from datetime import date
from typing import Any, Awaitable, Callable
from uuid import UUID

from sqlalchemy import func, or_, select
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.database import async_session_factory
from app.models.tag import Tag
from app.models.task import Task, TaskStatus
from app.models.task_tag import TaskTag
from app.models.user import User
from app.services import api_tokens_service
from app.services import task_service
from app.services.ai_service import is_premium
from app.services.habit_ai_tools import HABIT_TOOL_HANDLERS
from app.services.watchlist_ai_tools import WATCHLIST_TOOL_HANDLERS
from app.utils.rls import set_rls_user_id
from app.utils.uuid_helpers import parse_uuid

logger = logging.getLogger(__name__)

# Populated by the auth middleware per request; read by every tool.
_current_user_id: ContextVar[str | None] = ContextVar("mcp_current_user_id", default=None)

_mcp_session_manager: Any = None
_mcp_app: Starlette | None = None


def _resource_metadata_url() -> str:
    """RFC 9728 protected-resource metadata URL for MCP OAuth discovery."""
    origin = (settings.app_origin or "").rstrip("/")
    return f"{origin}/api/mcp/.well-known/oauth-protected-resource"


_OAuthVerifier = Callable[[str], Awaitable[dict | None]]
_oauth_verifier: _OAuthVerifier | None = None


async def _verify_oauth_access_token(token: str) -> dict | None:
    """Verify an MCP OAuth access JWT, returning the token claims or None.

    The open-core build has no OAuth authorization server, so only Personal
    Access Tokens authenticate. The private build installs a verifier below.
    """
    if _oauth_verifier is None:
        return None
    return await _oauth_verifier(token)




def _require_user_id() -> str:
    user_id = _current_user_id.get()
    if not user_id:
        raise PermissionError("Missing or expired MCP authentication")
    return user_id


def _is_pg(session) -> bool:
    bind = session.get_bind() if hasattr(session, "get_bind") else session
    if bind is None:
        return False
    return getattr(bind, "dialect", None) is not None and bind.dialect.name == "postgresql"


def _task_brief(task: Task) -> dict:
    return {
        "id": str(task.id),
        "title": task.title,
        "description": task.description,
        "status": task.status.value if task.status else None,
        "priority": task.priority,
        "start_date": str(task.start_date) if task.start_date else None,
        "due_date": str(task.due_date) if task.due_date else None,
        "is_archived": task.is_archived,
    }


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


async def _user_scoped(session_factory, fn):
    """Run ``fn(session, user_id)`` in a fresh RLS-keyed session, committing on
    success and rolling back on failure. Returns the fn result dict."""
    user_id = _require_user_id()
    async with session_factory() as session:
        try:
            if session.bind is not None and getattr(session.bind, "dialect", None) is not None \
                    and session.bind.dialect.name == "postgresql":
                await set_rls_user_id(session, UUID(user_id))
            result = await fn(session, UUID(user_id))
            await session.commit()
            return result
        except Exception:
            await session.rollback()
            raise


def _build_mcp_server(session_factory, json_response: bool = False):
    from mcp.server.fastmcp import FastMCP
    from mcp.server.transport_security import TransportSecuritySettings

    # DNS rebinding protection is disabled: the endpoint is Bearer-authed on
    # every request (our auth middleware) and sits behind the Next.js /api
    # rewrite + Cloudflare tunnel, so a Host-header allowlist would risk 421s
    # for legitimate hosts (prysmnote.com, backend, localhost, staging, ...).
    mcp = FastMCP(
        "Prysm Note",
        streamable_http_path="/",
        json_response=json_response,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @mcp.tool()
    async def search_tasks(query: str, limit: int = 20) -> dict:
        """Search tasks by title/description. Use when the user asks to find tasks."""
        async def run(session, user_id):
            ranked = await task_service.search_tasks(session, user_id, query, min(limit, 100))
            return {"count": len(ranked), "tasks": [{**_task_brief(t), "rank": round(rank, 3)} for t, rank in ranked]}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def create_task(
        title: str,
        description: str | None = None,
        start_date: str | None = None,
        due_date: str | None = None,
        priority: int = 2,
        status: str = "backlog",
        recurrence_rule: str | None = None,
        recurrence_end_date: str | None = None,
    ) -> dict:
        """Create a new task. Pass start_date/due_date as YYYY-MM-DD. Returns the created task."""
        async def run(session, user_id):
            task = await task_service.create_task(
                session, user_id=user_id, title=title, description=description,
                status=status, priority=priority, start_date=start_date,
                due_date=due_date, recurrence_rule=recurrence_rule,
                recurrence_end_date=recurrence_end_date,
            )
            return {"created": True, "task": _task_brief(task)}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def get_task_details(task_id: str) -> dict:
        """Fetch full details of a single task, including tags and subtasks."""
        async def run(session, user_id):
            task_uuid = parse_uuid(task_id)
            if task_uuid is None:
                return {"error": "Invalid task_id format"}
            task = await task_service.get_task(session, task_uuid, user_id)
            if task is None:
                return {"error": "Task not found"}
            tags_result = await session.execute(select(Tag).join(TaskTag).where(TaskTag.task_id == task.id))
            tags = [{"id": str(t.id), "name": t.name, "color": t.color} for t in tags_result.scalars().all()]
            subtasks_result = await session.execute(select(Task).where(Task.parent_task_id == task.id))
            subtasks = [{"id": str(t.id), "title": t.title, "status": t.status.value} for t in subtasks_result.scalars().all()]
            return {
                **_task_brief(task),
                "tags": tags,
                "subtasks": subtasks,
                "recurrence_rule": task.recurrence_rule,
                "recurrence_end_date": str(task.recurrence_end_date) if task.recurrence_end_date else None,
                "estimated_minutes": task.estimated_minutes,
            }
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def update_task(
        task_id: str,
        title: str | None = None,
        description: str | None = None,
        status: str | None = None,
        priority: int | None = None,
        start_date: str | None = None,
        due_date: str | None = None,
        recurrence_rule: str | None = None,
        recurrence_end_date: str | None = None,
        is_archived: bool | None = None,
    ) -> dict:
        """Update fields on an existing task. Only include fields that changed. Use status='done' to complete a task."""
        async def run(session, user_id):
            task_uuid = parse_uuid(task_id)
            if task_uuid is None:
                return {"error": "Invalid task_id format"}
            fields = {k: v for k, v in {
                "title": title, "description": description, "status": status,
                "priority": priority, "start_date": start_date, "due_date": due_date,
                "recurrence_rule": recurrence_rule, "recurrence_end_date": recurrence_end_date,
                "is_archived": is_archived,
            }.items() if v is not None}
            task = await task_service.update_task(session, task_uuid, fields, user_id)
            if task is None:
                return {"error": "Task not found"}
            return {"updated": True, "task": _task_brief(task)}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def complete_task(task_id: str) -> dict:
        """Mark a task as done/completed. Use when the user says a task is finished."""
        async def run(session, user_id):
            task_uuid = parse_uuid(task_id)
            if task_uuid is None:
                return {"error": "Invalid task_id format"}
            task = await task_service.get_task(session, task_uuid, user_id)
            if task is None:
                return {"error": "Task not found"}
            task.status = TaskStatus.DONE
            await session.flush()
            return {"completed": True, "task_id": task_id, "status": "done"}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def delete_task(task_id: str) -> dict:
        """Permanently delete a task. DESTRUCTIVE: only call after the user explicitly confirms which task to delete."""
        async def run(session, user_id):
            task_uuid = parse_uuid(task_id)
            if task_uuid is None:
                return {"error": "Invalid task_id format"}
            deleted = await task_service.delete_task(session, task_uuid, user_id)
            if not deleted:
                return {"error": "Task not found"}
            return {"deleted": True, "task_id": task_id}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def list_tasks_by_date_range(date_from: str, date_to: str) -> dict:
        """List open tasks overlapping a date range (YYYY-MM-DD to YYYY-MM-DD). Use to check what is already scheduled."""
        async def run(session, user_id):
            d_from = _parse_date(date_from)
            d_to = _parse_date(date_to)
            if d_from is None or d_to is None:
                return {"error": "date_from and date_to (YYYY-MM-DD) are required"}
            result = await session.execute(
                select(Task).where(
                    Task.user_id == user_id,
                    Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                    or_(
                        (Task.start_date >= d_from) & (Task.start_date <= d_to),
                        (Task.due_date >= d_from) & (Task.due_date <= d_to),
                        (Task.start_date <= d_from) & (Task.due_date >= d_to),
                    ),
                ).order_by(Task.start_date)
            )
            tasks = result.scalars().all()
            return {"date_from": date_from, "date_to": date_to, "count": len(tasks), "tasks": [_task_brief(t) for t in tasks]}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def check_calendar(date_from: str, date_to: str) -> dict:
        """Return how many open tasks are scheduled on each day in a range (calendar density / conflict check)."""
        async def run(session, user_id):
            d_from = _parse_date(date_from)
            d_to = _parse_date(date_to)
            if d_from is None or d_to is None:
                return {"error": "date_from and date_to (YYYY-MM-DD) are required"}
            count_result = await session.execute(
                select(Task.start_date, func.count(Task.id)).where(
                    Task.user_id == user_id,
                    Task.start_date.isnot(None),
                    Task.start_date >= d_from,
                    Task.start_date <= d_to,
                    Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                ).group_by(Task.start_date).order_by(Task.start_date)
            )
            return {
                "date_from": date_from,
                "date_to": date_to,
                "density": [{"date": str(row[0]), "count": row[1]} for row in count_result],
            }
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def list_tags() -> dict:
        """List the user's tags."""
        async def run(session, user_id):
            tag_result = await session.execute(select(Tag).where(Tag.user_id == user_id).order_by(Tag.name))
            tags = tag_result.scalars().all()
            return {"count": len(tags), "tags": [{"id": str(t.id), "name": t.name, "color": t.color} for t in tags]}
        return await _user_scoped(session_factory, run)

    @mcp.tool()
    async def add_tag_to_task(task_id: str, tag_name: str) -> dict:
        """Attach a tag to a task, creating the tag if needed."""
        async def run(session, user_id):
            task_uuid = parse_uuid(task_id)
            name = (tag_name or "").strip()
            if task_uuid is None:
                return {"error": "Invalid task_id format"}
            if not name:
                return {"error": "tag_name is required"}
            task = await task_service.get_task(session, task_uuid, user_id)
            if task is None:
                return {"error": "Task not found"}
            tag = (await session.execute(select(Tag).where(Tag.user_id == user_id, Tag.name == name))).scalar_one_or_none()
            if not tag:
                tag = Tag(user_id=user_id, name=name[:50])
                session.add(tag)
                await session.flush()
            existing = (await session.execute(
                select(TaskTag).where(TaskTag.task_id == task_uuid, TaskTag.tag_id == tag.id)
            )).scalar_one_or_none()
            if not existing:
                session.add(TaskTag(task_id=task_uuid, tag_id=tag.id))
                await session.flush()
            return {"added": True, "task_id": task_id, "tag": {"id": str(tag.id), "name": tag.name}}
        return await _user_scoped(session_factory, run)

    # Watchlist tools - delegate to the core handlers (same ownership scoping,
    # RLS-keyed session, JSON-serializable payloads). Signatures are explicit so
    # external LLM clients get a useful tool schema.
    async def _watchlist_call(name: str, args: dict) -> dict:
        async def run(session, user_id):
            return await WATCHLIST_TOOL_HANDLERS[name](args, str(user_id), session)
        return await _user_scoped(session_factory, run)

    @mcp.tool(name="search_titles", description="Search movies and TV shows by title (TMDB). Returns matches with tmdb_id, media_type, title, release_year and poster_url.")
    async def _t_search_titles(query: str) -> dict:
        return await _watchlist_call("search_titles", {"query": query})

    @mcp.tool(name="list_watchlist", description="List the user's watchlist items, optionally filtered by status (plan_to_watch, watching, watched).")
    async def _t_list_watchlist(status: str | None = None) -> dict:
        return await _watchlist_call("list_watchlist", {"status": status} if status else {})

    @mcp.tool(name="add_watchlist_item", description="Add a movie or TV show to the watchlist using tmdb_id and media_type from search_titles. rating is 1-10.")
    async def _t_add_watchlist_item(tmdb_id: int, media_type: str, title: str | None = None, release_year: int | None = None, poster_path: str | None = None, status: str | None = None, rating: int | None = None, notes: str | None = None) -> dict:
        return await _watchlist_call("add_watchlist_item", {
            "tmdb_id": tmdb_id, "media_type": media_type, "title": title,
            "release_year": release_year, "poster_path": poster_path,
            "status": status, "rating": rating, "notes": notes,
        })

    @mcp.tool(name="update_watchlist_item", description="Update a watchlist item (status, rating 1-10, notes, watched_at YYYY-MM-DD).")
    async def _t_update_watchlist_item(item_id: str, status: str | None = None, rating: int | None = None, notes: str | None = None, watched_at: str | None = None) -> dict:
        return await _watchlist_call("update_watchlist_item", {
            "item_id": item_id, "status": status, "rating": rating,
            "notes": notes, "watched_at": watched_at,
        })

    @mcp.tool(name="remove_watchlist_item", description="Permanently remove a watchlist item. DESTRUCTIVE: require explicit user confirmation before calling.")
    async def _t_remove_watchlist_item(item_id: str) -> dict:
        return await _watchlist_call("remove_watchlist_item", {"item_id": item_id})

    # Generic delegate for habit tools. Wraps a handler call in _user_scoped so
    # every tool gets a fresh RLS-keyed session.
    async def _feature_call(name: str, args: dict) -> dict:
        h = HABIT_TOOL_HANDLERS.get(name)
        if h:
            async def run(session, user_id):
                return await h(args, str(user_id), session)
            return await _user_scoped(session_factory, run)
        return {"error": f"Unknown tool: {name}"}

    # Habit tools
    @mcp.tool(name="list_habits", description="List the user's habits with current streak.")
    async def _t_list_habits() -> dict:
        return await _feature_call("list_habits", {})

    @mcp.tool(name="create_habit", description="Create a new habit. title, frequency (daily/weekly/monthly), optional target_count and color.")
    async def _t_create_habit(title: str, frequency: str = "daily", target_count: int = 1, color: str | None = None) -> dict:
        return await _feature_call("create_habit", {"title": title, "frequency": frequency, "target_count": target_count, "color": color})

    @mcp.tool(name="update_habit", description="Update a habit. habit_id required, plus any of title, frequency, target_count, color.")
    async def _t_update_habit(habit_id: str, title: str | None = None, frequency: str | None = None, target_count: int | None = None, color: str | None = None) -> dict:
        return await _feature_call("update_habit", {"habit_id": habit_id, "title": title, "frequency": frequency, "target_count": target_count, "color": color})

    @mcp.tool(name="delete_habit", description="Permanently delete a habit and its log history. DESTRUCTIVE: require explicit user confirmation.")
    async def _t_delete_habit(habit_id: str) -> dict:
        return await _feature_call("delete_habit", {"habit_id": habit_id})

    @mcp.tool(name="toggle_habit_log", description="Log (or unlog) today's completion for a habit. Returns logged, streak and date.")
    async def _t_toggle_habit_log(habit_id: str) -> dict:
        return await _feature_call("toggle_habit_log", {"habit_id": habit_id})

    @mcp.tool(name="get_habit_logs", description="List log dates for a habit, optionally filtered by from/to YYYY-MM-DD.")
    async def _t_get_habit_logs(habit_id: str, from_date: str | None = None, to_date: str | None = None) -> dict:
        return await _feature_call("get_habit_logs", {"habit_id": habit_id, "from": from_date, "to": to_date})


    return mcp


def _auth_middleware_factory(session_factory):
    class McpAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            # OAuth discovery metadata is intentionally unauthenticated so
            # clients can resolve the AS before they have any token. Mounted at
            # /api/mcp, so the full path carries the mount prefix on some
            # Starlette versions - match the suffix instead.
            if request.url.path.endswith("/.well-known/oauth-protected-resource"):
                return await call_next(request)
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return _unauthorized()
            token = auth_header[len("Bearer "):].strip()
            async with session_factory() as session:
                user_id = None
                # PAT path: prysm_live_* lookup on the BYPASSRLS system session.
                # The token owner is unknown before the lookup and api_tokens is
                # FORCE RLS on user_id = rls_user_id(), so the request session
                # (which has no GUC yet) would match zero rows.
                if token.startswith(api_tokens_service.TOKEN_PREFIX):
                    row = await api_tokens_service.lookup_token_system(token, session)
                    if row is None:
                        return _unauthorized()
                    user_id = str(row.user_id)
                else:
                    # OAuth access JWT path (private build only; the open-core
                    # verifier returns None so non-PAT tokens are rejected).
                    info = await _verify_oauth_access_token(token)
                    if info is None:
                        return _unauthorized()
                    user_id = info["user_id"]
                    # Password change (token_version bump) invalidates OAuth
                    # access tokens too.
                    user = await session.get(User, UUID(user_id))
                    if user is None:
                        return _unauthorized()
                    if info.get("token_version", 0) != user.token_version:
                        return _unauthorized()

                # Set GUC on the request session so is_premium (which may query
                # FORCE-RLS subscription tables in the private build) can find
                # the row. Set for both token paths once the user is known.
                if _is_pg(session):
                    await set_rls_user_id(session, UUID(user_id))

                premium = await is_premium(UUID(user_id), session)
                if not premium:
                    return _unauthorized_paid_required()
                await session.commit()
            _current_user_id.set(user_id)
            request.state.user_id = user_id
            try:
                return await call_next(request)
            finally:
                # Always clear the identity so a failed/aborted request can
                # never leak it to the next one handled by this task.
                _current_user_id.set(None)

    return McpAuthMiddleware


def _unauthorized() -> JSONResponse:
    """401 with the RFC 9728 resource_metadata challenge so OAuth-capable
    clients auto-discover the AS and prompt 'sign in via link'."""
    meta_url = _resource_metadata_url()
    return JSONResponse(
        status_code=401,
        content={"error": "Missing, invalid or expired bearer token"},
        headers={
            "WWW-Authenticate": f'Bearer resource_metadata="{meta_url}"',
        },
    )


def _unauthorized_paid_required() -> JSONResponse:
    return JSONResponse(
        status_code=402,
        content={"error": "MCP requires an active Premium subscription"},
        headers={
            "WWW-Authenticate": f'Bearer resource_metadata="{_resource_metadata_url()}"',
        },
    )


def _build_mcp_http_app(session_factory, json_response: bool = False) -> tuple[Starlette, object]:
    """Build a full Streamable HTTP ASGI app: MCP endpoint + OAuth discovery
    metadata + auth middleware. Returns (app, session_manager)."""
    mcp = _build_mcp_server(session_factory, json_response=json_response)
    app = mcp.streamable_http_app()
    app.add_middleware(_auth_middleware_factory(session_factory))

    # RFC 9728 protected-resource metadata for OAuth auto-discovery. Serves
    # at the resource server root so clients that receive the 401 challenge
    # can resolve the authorization-server metadata.
    async def _protected_resource_metadata(request: Request):
        origin = settings.app_origin.rstrip("/")
        return JSONResponse(
            {
                "resource": f"{origin}/api/mcp",
                "authorization_servers": [f"{origin}/api/ee/mcp-oauth"],
                "scopes_supported": [
                    "tasks", "watchlist", "habits",
                ],
            },
            headers={
                "Access-Control-Allow-Origin": "*",
            },
        )

    app.add_route(
        "/.well-known/oauth-protected-resource", _protected_resource_metadata, methods=["GET"]
    )

    return app, mcp.session_manager


def get_mcp_http_app(session_factory=async_session_factory) -> Starlette:
    """Build (once) the Streamable HTTP ASGI app for the MCP endpoint.

    The returned Starlette app is mounted at ``/api/mcp``; its session manager
    is started by the FastAPI lifespan via :func:`mcp_session_loop` (a mounted
    sub-app's own lifespan is not run by Starlette).
    """
    global _mcp_session_manager, _mcp_app
    if _mcp_app is None:
        _mcp_app, _mcp_session_manager = _build_mcp_http_app(session_factory)
    return _mcp_app


async def mcp_session_loop() -> None:
    """Background task keeping the MCP session manager alive until shutdown."""
    if _mcp_session_manager is None:
        return
    async with _mcp_session_manager.run():
        await asyncio.Event().wait()
