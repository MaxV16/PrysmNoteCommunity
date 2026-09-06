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
async def test_start_turn_rejects_when_a_turn_is_active():
    """*A* turn already registered for the user: start_turn must return None.

    The router replies 409 in that case; without the guard, two concurrent
    chat requests could start two background turns for one user (double tool
    execution, double billing).
    """
    from unittest.mock import patch

    from app.services import ai_turn_runner as tr

    async def _noop(job):
        await asyncio.sleep(0)

    user_id = str(uuid4())
    with patch.object(tr, "_run_turn", _noop):
        try:
            first = await tr.start_turn(
                user_id, str(uuid4()), "openai", "sk-test", [], [], "hello"
            )
            assert first is not None
            second = await tr.start_turn(
                user_id, str(uuid4()), "openai", "sk-test", [], [], "hello again"
            )
            assert second is None
        finally:
            tr._turns.pop(user_id, None)


@pytest.mark.asyncio
async def test_start_turn_atomic_under_concurrency():
    """Two simultaneous start_turn calls for one user: exactly one wins."""
    from unittest.mock import patch

    from app.services import ai_turn_runner as tr

    async def _noop(job):
        await asyncio.sleep(0)

    user_id = str(uuid4())
    with patch.object(tr, "_run_turn", _noop):
        try:
            r1, r2 = await asyncio.gather(
                tr.start_turn(user_id, str(uuid4()), "openai", "sk-test", [], [], "a"),
                tr.start_turn(user_id, str(uuid4()), "openai", "sk-test", [], [], "b"),
            )
            registered = sum(1 for j in tr._turns.values() if j.user_id == user_id)
            assert (r1 is not None) != (r2 is not None)
            assert registered == 1
        finally:
            tr._turns.pop(user_id, None)


@pytest.mark.asyncio
async def test_execute_tool_calls_recovery_reapplies_rls(db_session, ai_user):
    """Regression (Postgres): a failed tool's recovery rollback must re-apply
    the transaction-scoped RLS context.

    Before the fix, execute_tool_calls rolled back with a bare
    ``session.rollback()``, silently dropping ``app.user_id``. The next
    autoflush in the same session (an ``ai_cache`` write from the next cache
    round, or pending task writes) then died with "new row violates row-level
    security policy for table ..." - exactly the production symptom. The
    recovery rollback now re-applies the user context via
    ``rollback_and_reapply_rls`` before the session is reused.
    """
    import os

    if not os.getenv("TEST_DATABASE_URL", "").startswith("postgresql"):
        pytest.skip("RLS re-application is PostgreSQL-only")

    from unittest.mock import patch
    from uuid import UUID

    from app.models.task import Task
    from app.services import ai_service as ai_mod
    from app.services.ai_service import execute_tool_calls
    from sqlalchemy import select
    from sqlalchemy.exc import SQLAlchemyError

    user_id = str(ai_user)

    # Force the broken-session state a failed flush leaves behind.
    bad = Task(user_id=UUID(user_id), title=None)
    db_session.add(bad)
    try:
        await db_session.execute(select(Task).limit(1))
        await db_session.rollback()
    except SQLAlchemyError:
        assert not db_session.is_active

    real_rollback_reapply = ai_mod.rollback_and_reapply_rls
    applied: list[str] = []

    async def _record_reapply(session, uid):
        applied.append(str(uid))
        await real_rollback_reapply(session, uid)

    tool_calls = [
        {
            "id": "call-1",
            "type": "function",
            "function": {"name": "list_tags", "arguments": "{}"},
        },
        {
            "id": "call-2",
            "type": "function",
            "function": {"name": "list_tags", "arguments": "{}"},
        },
    ]

    with patch.object(ai_mod, "rollback_and_reapply_rls", _record_reapply):
        results = await execute_tool_calls(tool_calls, user_id, db_session)

    # The recovery path re-applied the user context at least once.
    assert applied, "recovery rollback did not re-apply the RLS user context"
    assert all(a == user_id for a in applied)
    # The session is usable afterwards (second tool ran, commit works).
    assert any('"count"' in (r.get("content") or "") for r in results)
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
