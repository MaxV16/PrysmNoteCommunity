"""Tests for the SSE event bus (app/services/events.py), the publish
middleware (app/middleware/events.py) and the stream route (app/routers/events.py).

The suite exercises the in-process fan-out fallback, which is the same path a
single-worker dev deployment uses when REDIS_URL is unset.
"""
import asyncio
import json
from uuid import uuid4

import pytest
from jose import jwt

from app.config import settings
import app.services.events as events_mod
from app.middleware.events import EventPublishMiddleware, _match_resource
from app.routers.events import stream_events
from app.services.events import (
    notify_user_event,
    publish_user_event,
    subscribe_user_events,
)


@pytest.fixture
def memory_events(monkeypatch):
    """Force the in-process fan-out and start with no subscribers."""
    monkeypatch.setattr(events_mod, "_async_redis", None)
    monkeypatch.setattr(events_mod, "_redis_checked", True)
    events_mod._subscribers.clear()
    yield events_mod
    events_mod._subscribers.clear()


async def _wait_for_subscriber(uid: str):
    for _ in range(50):
        if uid in events_mod._subscribers:
            return
        await asyncio.sleep(0)
    raise AssertionError("subscriber never registered")


def test_match_resource():
    assert _match_resource("/api/tasks") == "tasks"
    assert _match_resource("/api/tasks/abc") == "tasks"
    assert _match_resource("/api/board-sections") == "board_sections"
    assert _match_resource("/api/auth/login") is None
    assert _match_resource("/api/tasks-extra") is None


@pytest.mark.asyncio
async def test_subscribe_receives_published_event(memory_events):
    uid = str(uuid4())
    gen = subscribe_user_events(uid)
    pending = asyncio.create_task(gen.__anext__())
    await _wait_for_subscriber(uid)
    await publish_user_event(uid, "tasks", ["abc"])
    payload = await asyncio.wait_for(pending, timeout=2)
    assert json.loads(payload) == {"resource": "tasks", "ids": ["abc"]}
    await gen.aclose()


@pytest.mark.asyncio
async def test_notify_user_event_is_fire_and_forget(memory_events):
    uid = str(uuid4())
    gen = subscribe_user_events(uid)
    pending = asyncio.create_task(gen.__anext__())
    await _wait_for_subscriber(uid)
    notify_user_event(uid, "lists")
    payload = await asyncio.wait_for(pending, timeout=2)
    assert json.loads(payload)["resource"] == "lists"
    await gen.aclose()


@pytest.mark.asyncio
async def test_events_are_isolated_per_user(memory_events):
    uid1, uid2 = str(uuid4()), str(uuid4())
    gen = subscribe_user_events(uid1)
    pending = asyncio.create_task(gen.__anext__())
    await _wait_for_subscriber(uid1)

    await publish_user_event(uid2, "tasks")
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(pending), timeout=0.2)

    await publish_user_event(uid1, "tasks")
    payload = await asyncio.wait_for(pending, timeout=2)
    assert json.loads(payload)["resource"] == "tasks"
    await gen.aclose()


def _access_token(uid: str) -> str:
    return jwt.encode(
        {"sub": uid, "type": "access"},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


async def _run_middleware(monkeypatch, method, path, status, token=None):
    calls = []
    monkeypatch.setattr(
        "app.middleware.events.notify_user_event",
        lambda uid, resource, ids=None: calls.append((uid, resource)),
    )
    headers = []
    if token is not None:
        headers.append((b"cookie", f"access_token={token}".encode()))
    scope = {"type": "http", "method": method, "path": path, "headers": headers}

    async def fake_app(scope, receive, send):
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return {"type": "http.request"}

    async def send(message):
        return None

    await EventPublishMiddleware(fake_app)(scope, receive, send)
    return calls


@pytest.mark.asyncio
async def test_middleware_publishes_on_mutation(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "POST", "/api/tasks/", 200, _access_token(uid))
    assert calls == [(uid, "tasks")]


@pytest.mark.asyncio
async def test_middleware_publishes_on_created(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "PATCH", "/api/tasks/abc", 201, _access_token(uid))
    assert calls == [(uid, "tasks")]


@pytest.mark.asyncio
async def test_middleware_skips_server_error(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "POST", "/api/tasks/", 500, _access_token(uid))
    assert calls == []


@pytest.mark.asyncio
async def test_middleware_skips_client_error(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "DELETE", "/api/tasks/abc", 404, _access_token(uid))
    assert calls == []


@pytest.mark.asyncio
async def test_middleware_skips_safe_method(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "GET", "/api/tasks/", 200, _access_token(uid))
    assert calls == []


@pytest.mark.asyncio
async def test_middleware_skips_unrelated_path(monkeypatch):
    uid = str(uuid4())
    calls = await _run_middleware(monkeypatch, "POST", "/api/auth/login", 200, _access_token(uid))
    assert calls == []


@pytest.mark.asyncio
async def test_middleware_skips_without_cookie(monkeypatch):
    calls = await _run_middleware(monkeypatch, "POST", "/api/tasks/", 200, None)
    assert calls == []


@pytest.mark.asyncio
async def test_middleware_skips_non_access_token(monkeypatch):
    refresh = jwt.encode(
        {"sub": str(uuid4()), "type": "refresh"},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    calls = await _run_middleware(monkeypatch, "POST", "/api/tasks/", 200, refresh)
    assert calls == []


@pytest.mark.asyncio
async def test_events_endpoint_requires_auth(auth_client):
    res = await auth_client.get("/api/events")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_events_endpoint_streams_change(memory_events):
    uid = uuid4()
    response = await stream_events(None, uid)
    assert response.media_type == "text/event-stream"
    it = response.body_iterator
    assert await it.__anext__() == "retry: 5000\n\n"
    assert (await it.__anext__()).startswith(": connected")

    pending = asyncio.create_task(it.__anext__())
    await _wait_for_subscriber(str(uid))
    await publish_user_event(str(uid), "tasks")
    chunk = await asyncio.wait_for(pending, timeout=2)
    assert chunk.startswith("event: change")
    data = json.loads(chunk.split("data: ", 1)[1])
    assert data["resource"] == "tasks"
    await it.aclose()
