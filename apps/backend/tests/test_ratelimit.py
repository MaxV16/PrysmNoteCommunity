import pytest
from httpx import AsyncClient

from app.config import settings
from app.middleware import ratelimit as ratelimit_mod
from app.utils import ratelimit as rl_utils


@pytest.mark.asyncio
async def test_global_api_rate_limit_429(auth_client: AsyncClient):
    """With a tiny threshold, the global per-IP limiter returns 429 once the
    window budget is spent. Health and the CSRF-exempt auth paths stay open."""
    settings.api_rate_limit_enabled = True
    settings.api_rate_limit_per_min = 3
    ratelimit_mod._api_limiter = rl_utils.RateLimiter("rl:api")  # fresh counter
    try:
        # The middleware counts every /api request (before auth). First 3 pass
        # through (the route then 401s for a logged-out client — fine).
        for _ in range(3):
            resp = await auth_client.get("/api/tasks/")
            assert resp.status_code != 429, resp.text

        # ...the 4th within the same minute is throttled.
        resp = await auth_client.get("/api/tasks/")
        assert resp.status_code == 429

        # /api/health is exempt from the global limiter.
        health = await auth_client.get("/api/health")
        assert health.status_code == 200
    finally:
        settings.api_rate_limit_enabled = False
        settings.api_rate_limit_per_min = 120
        ratelimit_mod._api_limiter = rl_utils.RateLimiter("rl:api")


@pytest.mark.asyncio
async def test_ratelimiter_memory_fallback_counts_window():
    """The in-memory fallback is a sliding window: old hits drop out of the
    window so the count does not grow forever."""
    import time

    limiter = rl_utils.RateLimiter("test")
    now = time.time()
    for i in range(5):
        assert limiter.count("k", 60) == i + 1
    # Expire the window: a fresh count starts at 1.
    time_mock = type("T", (), {"time": staticmethod(lambda: now + 61)})()
    original_time = rl_utils.time
    rl_utils.time = time_mock
    try:
        assert limiter.count("k", 60) == 1
    finally:
        rl_utils.time = original_time
    assert rl_utils.time is original_time


@pytest.mark.asyncio
async def test_ratelimiter_block_flag_expires():
    """block() sets a time-boxed flag; is_blocked() returns False after the
    duration has elapsed."""
    import time

    limiter = rl_utils.RateLimiter("test2")
    now = time.time()
    limiter.block("k", 60)
    assert limiter.is_blocked("k") is True

    time_mock = type("T", (), {"time": staticmethod(lambda: now + 61)})()
    original_time = rl_utils.time
    rl_utils.time = time_mock
    try:
        assert limiter.is_blocked("k") is False
    finally:
        rl_utils.time = original_time


class _FakeRedisPipeline:
    def __init__(self, client):
        self.client = client
        self.cmds = []

    def incr(self, key):
        self.cmds.append(("incr", key))
        return self

    def expire(self, key, ttl, nx=False):
        self.cmds.append(("expire", key, ttl, nx))
        return self

    def execute(self):
        return [self.client._incr_counter for _ in self.cmds]


class _FakeRedis:
    def __init__(self):
        self._incr_counter = 0
        self._blocks = {}

    def pipeline(self):
        return _FakeRedisPipeline(self)

    def set(self, key, value, ex=None):
        self._blocks[key] = ex

    def exists(self, key):
        return int(key in self._blocks)

    def ping(self):
        return True


@pytest.mark.asyncio
async def test_ratelimiter_uses_redis_when_available():
    """When a Redis client is present, counters and blocks go through it (and a
    failing Redis call fails open to the in-memory fallback)."""
    fake = _FakeRedis()
    fake._incr_counter = 7
    original_checked, original_client = rl_utils._redis_checked, rl_utils._redis_client
    rl_utils._redis_checked = True
    rl_utils._redis_client = fake
    try:
        limiter = rl_utils.RateLimiter("rl:x")
        assert limiter.count("k", 60) == 7
        assert limiter.is_blocked("b") is False
        limiter.block("b", 120)
        assert limiter.is_blocked("b") is True
    finally:
        rl_utils._redis_checked, rl_utils._redis_client = original_checked, original_client


@pytest.mark.asyncio
async def test_ratelimiter_fails_open_on_redis_error():
    """A Redis call that raises must fall back to the in-memory dict instead of
    crashing the request."""

    class _BoomRedis:
        def pipeline(self):
            raise RuntimeError("redis down")

        def set(self, key, value, ex=None):
            raise RuntimeError("redis down")

        def exists(self, key):
            raise RuntimeError("redis down")

    boom = _BoomRedis()
    original_checked, original_client = rl_utils._redis_checked, rl_utils._redis_client
    rl_utils._redis_checked = True
    rl_utils._redis_client = boom
    try:
        limiter = rl_utils.RateLimiter("rl:y")
        assert limiter.count("k", 60) == 1  # counted in memory, not a crash
        assert limiter.is_blocked("k") is False
        limiter.block("k", 60)
        assert limiter.is_blocked("k") is True
    finally:
        rl_utils._redis_checked, rl_utils._redis_client = original_checked, original_client
