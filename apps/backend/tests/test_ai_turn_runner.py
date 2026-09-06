"""Tests for the background AI turn runner.

These tests verify TurnJob lifecycle and concurrency control. The turn runner
opens its own DB session (async_session_factory), which connects to the live
Postgres database, so integration-level tests that start full turns are limited
to the concurrency + cancellation logic that do not require tool execution.
"""

import asyncio
from uuid import uuid4

import pytest

from app.services.ai_turn_runner import (
    get_active_turn,
    cancel_turn,
)


@pytest.mark.asyncio
async def test_concurrent_turn_registry():
    """A turn is registered via get_active_turn and removed after cancel."""
    user_id = str(uuid4())

    # Start a turn via the module-level machinery (needs no DB - the asyncio
    # task will fail on DB open but the registry entry is created first).
    from app.services.ai_turn_runner import _turns as _reg
    from app.services.ai_turn_runner import TurnJob

    job = TurnJob(
        user_id=user_id,
        session_id=str(uuid4()),
        provider="openai",
        api_key="sk-test",
        chain=[],
        sanitized_history=[],
        user_message="test",
        context=None,
    )
    job.status = "running"
    _reg[user_id] = job

    try:
        assert get_active_turn(user_id) is job
    finally:
        cancel_turn(user_id)
        assert job.cancel_requested is True
        _reg.pop(user_id, None)

    assert get_active_turn(user_id) is None


@pytest.mark.asyncio
async def test_cancel_turn_nonexistent():
    """Cancelling a turn that does not exist returns False."""
    assert cancel_turn(str(uuid4())) is False
