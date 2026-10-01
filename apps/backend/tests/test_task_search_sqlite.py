"""Regression: task search SQL must stay portable to SQLite.

``search_tasks`` uses a pg_trgm similarity path and falls back to an ILIKE
substring path when the extension/dialect is unavailable (e.g. SQLite, which
the EE test suite and the MCP ``search_tasks`` tool exercise). That fallback
originally built its LIKE pattern with SQL ``concat('%', q, '%')``; ``concat()``
only exists on PostgreSQL and SQLite >= 3.44, so on the CI Python's bundled
SQLite the fallback raised ``no such function: concat`` and the tool returned an
error instead of matches.

This asserts two things: the executed SQL never calls ``concat(``, and the
fallback actually returns the matching task on in-memory SQLite.
"""
from uuid import uuid4

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.main import app  # noqa: F401  # importing app registers every model on Base.metadata
from app.models.base import Base
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services import task_service


@pytest.mark.asyncio
async def test_search_tasks_sqlite_fallback_is_portable():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    executed: list[str] = []

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_functions(dbapi_conn, record):
        dbapi_conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _capture(conn, cursor, statement, parameters, context, executemany):
        executed.append(statement)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        user = User(
            id=uuid4(),
            email=f"search-{uuid4().hex[:8]}@test.test",
            password_hash="not-a-real-hash",
            display_name="T",
        )
        s.add(user)
        await s.flush()
        s.add(Task(user_id=user.id, title="Secret A", description="a needle", status=TaskStatus.TODO))
        await s.commit()

    async with factory() as s:
        ranked = await task_service.search_tasks(s, user.id, "Secret", limit=10)

    await engine.dispose()

    assert any(t.title == "Secret A" for t, _ in ranked), "SQLite fallback search found no match"
    offending = [sql for sql in executed if "concat(" in sql.lower()]
    assert not offending, f"portable task search must not use SQL concat(): {offending}"
