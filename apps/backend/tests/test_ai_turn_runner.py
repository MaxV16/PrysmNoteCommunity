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
    _APPLIED_LINE_CAP,
    _extract_applied_actions,
    _summarize_tool_result,
    should_money_nudge,
    stream_fallback_reply,
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
async def test_summarize_tool_result_extracts_applied_actions():
    """Tool results with committed side effects produce one human line each;
    read-only listings and errors produce none."""
    assert (
        _summarize_tool_result(json.dumps({"created": True, "task": {"title": "Car mechanic appointment", "start_date": "2026-09-07"}}))
        == 'Added "Car mechanic appointment" (2026-09-07)'
    )
    assert (
        _summarize_tool_result(json.dumps({"created": True, "name": "Monthly income"}))
        == 'Added "Monthly income"'
    )
    assert _summarize_tool_result(json.dumps({"created_count": 3, "tasks": [{"title": "A"}, {"title": "B"}]})) == "Added 3 task(s)"
    assert _summarize_tool_result(json.dumps({"completed": True, "task_id": "x"})) == "Completed an item"
    assert _summarize_tool_result(json.dumps({"updated": True, "name": "Rent"})) == 'Updated "Rent"'
    assert _summarize_tool_result(json.dumps({"deleted": True, "task_id": "x"})) == "Deleted an item"
    assert _summarize_tool_result(json.dumps({"cancelled_count": 2})) == "Cancelled 2 task(s)"
    # Read-only / error / no-op results carry no side-effect key.
    assert _summarize_tool_result(json.dumps({"found": 4, "tasks": []})) is None
    assert _summarize_tool_result(json.dumps({"error": "Task not found"})) is None
    assert _summarize_tool_result("not json") is None


@pytest.mark.asyncio
async def test_extract_applied_actions_dedupes_and_caps():
    """The per-round extraction dedupes repeated lines and caps the list."""
    results = [
        {"content": json.dumps({"created": True, "name": "One"})},
        {"content": json.dumps({"created": True, "name": "One"})},
        {"content": json.dumps({"created": True, "name": "Two"})},
        {"content": json.dumps({"found": 1, "tasks": []})},
    ]
    lines = _extract_applied_actions(results)
    assert lines == ['Added "One"', 'Added "Two"']

    many = [
        {"content": json.dumps({"created": True, "name": f"Item {i}"})}
        for i in range(20)
    ]
    # Extraction itself does not truncate (the loop caps by slicing); verify it
    # keeps all distinct lines so the cap stays in the runner loop.
    assert len(_extract_applied_actions(many)) == 20
    assert _APPLIED_LINE_CAP == 6


def test_stream_fallback_reply_summary():
    """Item 24a: when tool work committed but the final stream died, the reply
    summarizes the applied actions and never shows the cold generic error."""
    applied = ['Added "Car mechanic appointment" (2026-09-07)', 'Added "Monthly income"']
    reply = stream_fallback_reply("", applied)
    assert "Car mechanic appointment" in reply
    assert "Monthly income" in reply
    assert "couldn't get a response" not in reply

    # Tool-round content wins over the summary when present.
    assert stream_fallback_reply("I created the tasks for you.", applied) == "I created the tasks for you."

    # Item 24b: no tool work + empty stream -> the generic text stays.
    cold = stream_fallback_reply("", [])
    assert "couldn't get a response" in cold


def test_should_money_nudge():
    """Item 29: premium user whose tool round only called task tools on a money
    message gets nudged toward finance (once); free users are never nudged."""
    task_call = [{"function": {"name": "create_task"}}]
    finance_call = [{"function": {"name": "add_financial_item"}}]

    # Money + only task tools -> nudge (bump available).
    assert should_money_nudge(True, task_call, money_hit=True, money_nudged=False, current_model_index=0, chain_len=2)
    # Free user -> never nudge (no finance tools exist for them).
    assert not should_money_nudge(False, task_call, money_hit=True, money_nudged=False, current_model_index=0, chain_len=2)
    # No money intent -> no nudge.
    assert not should_money_nudge(True, task_call, money_hit=False, money_nudged=False, current_model_index=0, chain_len=2)
    # Already nudged -> never twice.
    assert not should_money_nudge(True, task_call, money_hit=True, money_nudged=True, current_model_index=0, chain_len=2)
    # Finance tool already in the round -> no nudge needed.
    assert not should_money_nudge(True, finance_call, money_hit=True, money_nudged=False, current_model_index=0, chain_len=2)
    # No model bump left -> no nudge.
    assert not should_money_nudge(True, task_call, money_hit=True, money_nudged=False, current_model_index=1, chain_len=2)
    # No tool calls at all -> retry logic handles it, not the nudge.
    assert not should_money_nudge(True, None, money_hit=True, money_nudged=False, current_model_index=0, chain_len=2)


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


def test_money_refusal_detection_feeds_nudge():
    """The inline money-refusal nudge (triggered when a premium money request is
    answered with a tool-free refusal) depends on money_intent + the refusal
    patterns: both must fire on the prod conversation, and stay quiet for a
    neutral question."""
    from app.services.ai_service import _TOOL_REFUSAL_PATTERNS, money_intent

    user_msg = (
        "I actually cancel the 25th payment every month for a credit card, "
        "all of those, and instead make it be the 24th to pay off credit card."
    )
    refusal = (
        "I'm sorry for any inconvenience, but I currently don't have the tools "
        "to assist with changing your payment date."
    )
    assert money_intent(user_msg) is True
    assert _TOOL_REFUSAL_PATTERNS.search(refusal) is not None
    # A neutral question is neither money nor refusal.
    assert money_intent("what is 2 plus 2") is False
    assert _TOOL_REFUSAL_PATTERNS.search("the toolshed is behind the house") is None


@pytest.mark.asyncio
async def test_retry_final_non_streaming_uses_plain_chat():
    """When the final stream dies with nothing to report, one non-streaming
    `client.chat` attempt can still produce a reply (some providers' streaming
    path fails while the plain chat path answers)."""
    from app.services import ai_turn_runner as tr
    from app.services.ai_turn_runner import _retry_final_non_streaming

    class _FakeClient:
        def __init__(self, content="Done via non-streaming."):
            self.content = content
            self.calls = 0

        async def chat(self, messages, tools=None):
            self.calls += 1
            return {"choices": [{"message": {"content": self.content}}]}

    async def _fake_record_usage(session, job, response):
        pass

    client = _FakeClient()
    original = tr.record_usage
    tr.record_usage = _fake_record_usage
    try:
        reply = await _retry_final_non_streaming(client, [{"role": "user", "content": "hi"}], None, object())
        assert reply == "Done via non-streaming."
        assert client.calls == 1
    finally:
        tr.record_usage = original


@pytest.mark.asyncio
async def test_retry_final_non_streaming_empty_when_chat_fails():
    """A failing non-streaming retry yields "" so the cold fallback text stays."""
    from app.services import ai_turn_runner as tr
    from app.services.ai_turn_runner import _retry_final_non_streaming

    class _BoomClient:
        async def chat(self, messages, tools=None):
            raise RuntimeError("stream provider down")

    async def _fake_record_usage(session, job, response):
        pass

    original = tr.record_usage
    tr.record_usage = _fake_record_usage
    try:
        reply = await _retry_final_non_streaming(_BoomClient(), [{"role": "user", "content": "hi"}], None, object())
        assert reply == ""
    finally:
        tr.record_usage = original
