"""Pure-ASGI middleware that broadcasts a change event after a successful mutation.

This lets connected clients (via ``GET /api/events``) refresh only the resource
that changed instead of polling. It is deliberately implemented as raw ASGI
rather than a ``BaseHTTPMiddleware`` so it never buffers or interferes with the
long-lived SSE response, and it never holds a DB session or blocks the request.

The publisher is best-effort: any failure (no cookie, bad token, Redis down)
simply means no event is emitted, and the request is unaffected.
"""

from __future__ import annotations

from jwt import decode as jwt_decode
from jwt import PyJWTError

from app.config import settings
from app.services.events import notify_user_event

# First path segment (after /api/) -> logical resource name sent to clients.
_RESOURCE_PREFIXES = (
    ("/api/tasks", "tasks"),
    ("/api/tags", "tags"),
    ("/api/lists", "lists"),
    ("/api/board-sections", "board_sections"),
    ("/api/notes", "notes"),
    ("/api/preferences", "preferences"),
    ("/api/watchlist", "watchlist"),
    ("/api/habits", "habits"),
    ("/api/finance", "finance"),
)

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _match_resource(path: str) -> str | None:
    for prefix, resource in _RESOURCE_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return resource
    return None


def _cookie_value(scope, name: str) -> str | None:
    for header_name, header_value in scope.get("headers") or []:
        if header_name == b"cookie":
            for part in header_value.decode("latin-1").split(";"):
                key, _, value = part.strip().partition("=")
                if key == name and value:
                    return value
    return None


class EventPublishMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        resource = _match_resource(scope.get("path", ""))
        if method not in _UNSAFE_METHODS or resource is None:
            await self.app(scope, receive, send)
            return

        status_holder = {"status": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        await self.app(scope, receive, send_wrapper)

        if 200 <= status_holder["status"] < 400:
            user_id = self._user_id_from_cookie(scope)
            if user_id:
                notify_user_event(user_id, resource)

    @staticmethod
    def _user_id_from_cookie(scope) -> str | None:
        token = _cookie_value(scope, "access_token")
        if not token:
            return None
        try:
            payload = jwt_decode(
                token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm]
            )
        except PyJWTError:
            return None
        if payload.get("type") != "access":
            return None
        return payload.get("sub")
