"""RLS (Row-Level Security) session helpers.

The request path calls ``set_rls_user_id`` once per request because ``get_db``
hands out a session that stays in ONE transaction for the whole request. Code
that opens its own long-lived session (background turn runner, distillation,
imports) commits repeatedly, and each commit ends the transaction - so a
transaction-local ``SET LOCAL app.user_id`` is silently lost on the next query,
and every write then violates RLS.

The fix: background sessions must re-apply the RLS context after every
commit/rollback. ``rls_session`` opens a factory session and applies the context
immediately; the turn runner additionally wraps its own commits/rollbacks to
re-apply it per transaction (see ``app/services/ai_turn_runner.py``).
"""

from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory


async def set_rls_user_id(session: AsyncSession, user_id: UUID) -> None:
    # set_config(text, text, is_local=true) is the parameterized, transaction-
    # scoped equivalent of `SET LOCAL app.user_id = '...'` - asyncpg cannot
    # bind parameters inside a SET statement, and interpolating would be unsafe.
    await session.execute(
        text("SELECT set_config('app.user_id', :user_id, true)").bindparams(
            user_id=str(user_id)
        ),
    )


async def commit_and_reapply_rls(session: AsyncSession, user_id: UUID) -> None:
    """Commit the current transaction, then re-apply the RLS user context.

    Committing hands the pooled connection back and ends the transaction, so
    the transaction-scoped ``app.user_id`` is lost on the next query. Sessions
    that commit several times (background turn runner) MUST call this on every
    commit/rollback or the next write violates RLS.
    """
    await session.commit()
    if session.get_bind().dialect.name == "postgresql":
        await set_rls_user_id(session, user_id)


async def rollback_and_reapply_rls(session: AsyncSession, user_id: UUID) -> None:
    """Roll back the current transaction, then re-apply the RLS context."""
    await session.rollback()
    if session.get_bind().dialect.name == "postgresql":
        await set_rls_user_id(session, user_id)


@asynccontextmanager
async def rls_session(user_id: UUID | str):
    """Open a session pre-applied with the given user's RLS context.

    Use this instead of ``async_session_factory()`` in code that opens its own
    session to read/write rows for a specific user (background turn runner,
    distillation tasks). The RLS context is transaction-scoped, so callers that
    commit must re-apply it before the next query.

    Only Postgres supports ``set_config``; SQLite (CI/tests) is skipped.
    """
    async with async_session_factory() as session:
        dialect = session.bind.dialect.name if session.bind else "sqlite"
        if dialect == "postgresql":
            await set_rls_user_id(session, UUID(str(user_id)))
        try:
            yield session
        except Exception:
            await session.rollback()
            raise