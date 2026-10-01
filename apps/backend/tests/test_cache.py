"""Tests for the cache-aside helper (app/utils/cache.py) and its use in the
tags router. The suite runs against the in-memory fallback (no Redis in tests),
which is the same code path single-worker dev uses when REDIS_URL is unset."""
import pytest

from app.utils.cache import (
    cache_delete,
    cache_delete_prefix,
    cache_get,
    cache_set,
    user_cache_key,
)


@pytest.fixture
def memory_cache(monkeypatch):
    """Force the in-process fallback and start from an empty cache."""
    import app.utils.cache as cache_mod

    monkeypatch.setattr(cache_mod, "_redis", None)
    monkeypatch.setattr(cache_mod, "_redis_unavailable", True)
    cache_mod._mem.clear()
    yield cache_mod
    cache_mod._mem.clear()


def test_user_cache_key_has_no_suffix():
    assert user_cache_key("tags", "u1") == "cache:tags:u1"


def test_user_cache_key_with_parts():
    key = user_cache_key("board_sections", "u1", "kanban", "none")
    assert key == "cache:board_sections:u1:kanban:none"


def test_user_cache_keys_are_per_user():
    assert user_cache_key("tags", "u1") != user_cache_key("tags", "u2")


@pytest.mark.asyncio
async def test_set_get_round_trip(memory_cache):
    await cache_set("k", {"a": 1, "b": ["x"]}, ttl=30)
    assert await cache_get("k") == {"a": 1, "b": ["x"]}


@pytest.mark.asyncio
async def test_get_miss(memory_cache):
    assert await cache_get("absent") is None


@pytest.mark.asyncio
async def test_delete(memory_cache):
    await cache_set("k", [1, 2])
    await cache_delete("k")
    assert await cache_get("k") is None


@pytest.mark.asyncio
async def test_delete_prefix(memory_cache):
    await cache_set("cache:tags:u1", [1])
    await cache_set("cache:tags:u1:extra", [2])
    await cache_set("cache:lists:u1", [3])
    await cache_delete_prefix("cache:tags:u1")
    assert await cache_get("cache:tags:u1") is None
    assert await cache_get("cache:tags:u1:extra") is None
    assert await cache_get("cache:lists:u1") == [3]


@pytest.mark.asyncio
async def test_ttl_expiry(memory_cache):
    await cache_set("k", 1, ttl=0)
    assert await cache_get("k") is None


@pytest.mark.asyncio
async def test_list_tags_is_cached_and_invalidated_on_mutation(
    client, db_session, test_user
):
    """A read is served from cache (stale DB rows stay hidden) and any tag
    mutation invalidates it so the next read is fresh."""
    from app.models.tag import Tag

    first = await client.get("/api/tags/")
    assert first.status_code == 200
    assert first.json() == []

    # Insert a tag WITHOUT going through the router, so the only way it can be
    # hidden from the next read is a cache hit.
    db_session.add(Tag(user_id=test_user.id, name="bypassed"))
    await db_session.commit()

    cached = await client.get("/api/tags/")
    assert cached.json() == []

    # A route mutation invalidates the cached list.
    created = await client.post("/api/tags/", json={"name": "fresh"})
    assert created.status_code == 200

    fresh = await client.get("/api/tags/")
    assert {t["name"] for t in fresh.json()} == {"bypassed", "fresh"}
