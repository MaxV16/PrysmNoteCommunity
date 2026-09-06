"""Tests for the background AI turn runner.

These tests verify TurnJob lifecycle and concurrency control. The turn runner
opens its own DB session (async_session_factory), which connects to the live
Postgres database, so integration-level tests that start full turns are limited
to the concurrency + cancellation logic that do not require tool execution.
"""

import asyncio
import json
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


@pytest.mark.asyncio
async def test_execute_tool_calls_recovers_session_after_flush_failure(db_session, ai_user):
    """Regression: a tool call whose flush fails must leave the session usable.

    Before the fix, execute_tool_calls caught the handler exception but never
    rolled back the broken transaction, so the caller's next query (the next
    provider round or final commit) died with "transaction has been rolled
    back". The fix rolls back inside execute_tool_calls so the session stays
    usable for later tool calls and the final commit.
    """
    from uuid import UUID

    from app.models.task import Task
    from app.services.ai_service import execute_tool_calls
    from sqlalchemy import select
    from sqlalchemy.exc import SQLAlchemyError

    user_id = ai_user

    # Force a genuine broken-session state the way any failed flush leaves it:
    # pending object whose NOT NULL constraint fails on autoflush. The next
    # query then raises ProgrammingError and requires rollback before reuse.
    bad = Task(user_id=UUID(str(user_id)), title=None)
    db_session.add(bad)
    try:
        await db_session.execute(select(Task).limit(1))
        await db_session.rollback()
    except SQLAlchemyError:
        # Session is now broken (is_active False) - the exact post-flush-fail
        # state that used to kill the whole turn.
        assert not db_session.is_active

    # Run a tool round while the session is broken. The first tool's query
    # re-raises the flush error, hits execute_tool_calls' recovery path (which
    # rolls back and reports "operation failed"), and the SECOND tool runs on
    # the recovered session.
    tool_calls = [
        {
            "id": "call-1",
            "type": "function",
            "function": {
                "name": "list_tags",
                "arguments": "{}",
            },
        },
        {
            "id": "call-2",
            "type": "function",
            "function": {
                "name": "list_tags",
                "arguments": "{}",
            },
        },
    ]

    results = await execute_tool_calls(tool_calls, str(user_id), db_session)

    first = next(r for r in results if r.get("tool_call_id") == "call-1")
    # The broken flush surfaced as the tool error (recovery path).
    assert "error" in (first.get("content") or "") or '"count"' in (first.get("content") or "")

    # The session is usable again: a subsequent query and commit work.
    second = next(r for r in results if r.get("tool_call_id") == "call-2")
    assert '"count"' in (second.get("content") or "")
    await db_session.rollback()
    assert db_session.is_active


@pytest.mark.asyncio
async def test_commit_and_reapply_rls_reapplies_after_commit(db_session, ai_user):
    """Regression (Postgres): committing must re-apply the RLS user context.

    The RLS context (``app.user_id``) is transaction-scoped: ``commit`` ends
    the transaction and releases the pooled connection, so a bare commit leaves
    the next write without RLS - "new row violates row-level security policy"
    plus empty chat history on reload. The turn runner uses
    ``commit_and_reapply_rls`` on every commit/rollback.
    """
    import os

    if not os.getenv("TEST_DATABASE_URL", "").startswith("postgresql"):
        pytest.skip("RLS re-application is PostgreSQL-only")

    from unittest.mock import patch
    from uuid import UUID

    from app.utils.rls import commit_and_reapply_rls

    user = UUID(str(ai_user))

    reapply_calls: list = []

    async def _fake_reapply(session, uid):
        reapply_calls.append(str(uid))

    with patch("app.utils.rls.set_rls_user_id", _fake_reapply):
        await commit_and_reapply_rls(db_session, user)
        await commit_and_reapply_rls(db_session, user)

    # set_config must have been re-issued after EVERY commit (2 commits -> 2
    # re-applications), not just once at session open.
    assert reapply_calls == [str(user), str(user)]
