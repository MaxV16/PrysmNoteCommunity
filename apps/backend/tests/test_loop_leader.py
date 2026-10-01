"""Regression tests for the multi-worker leader election (loop_leader).

The Postgres advisory-lock path is exercised by the live integration check; these
cover the deterministic platform-independent contract that keeps dev/CI (SQLite)
and single-worker behavior unchanged.
"""
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.services.loop_leader import (
    release_background_leadership,
    serialize_schema_provisioning,
    try_acquire_background_leadership,
)


@pytest.mark.asyncio
async def test_non_postgres_url_always_leads():
    """SQLite (dev/CI) must never be blocked by leadership: the single process
    has to run the loops."""
    assert await try_acquire_background_leadership("sqlite+aiosqlite:///:memory:") is True


@pytest.mark.asyncio
async def test_serialize_schema_provisioning_runs_provision_on_sqlite():
    """On SQLite the advisory lock is skipped and the provisioning callable still
    runs exactly once."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    calls: list[int] = []

    async def provision() -> None:
        calls.append(1)

    try:
        await serialize_schema_provisioning(engine, provision)
    finally:
        await engine.dispose()
    assert calls == [1]


@pytest.mark.asyncio
async def test_release_leadership_is_idempotent():
    """Release must be safe to call with no held lock (shutdown path)."""
    await release_background_leadership()
    await release_background_leadership()
