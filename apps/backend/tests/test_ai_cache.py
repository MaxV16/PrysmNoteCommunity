"""LLM response-cache tests (core)."""
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.models.base import Base
import app.models.ai_cache  # noqa: F401  # register table on Base
import app.models.ai_usage  # noqa: F401

from app.services import ai_cache


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_connect_functions(dbapi_conn, record):
        import sqlite3
        from uuid import uuid4 as _uuid4

        dbapi_conn.create_function("gen_random_uuid", 0, lambda: str(_uuid4()))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


def test_cache_key_is_deterministic_and_order_sensitive():
    user = uuid4()
    messages = [{"role": "user", "content": "hello"}]
    k1 = ai_cache.make_cache_key(user, "prysmai", messages, None)
    k2 = ai_cache.make_cache_key(user, "prysmai", messages, None)
    k3 = ai_cache.make_cache_key(user, "prysmai", [{"role": "user", "content": "bye"}], None)
    assert k1 == k2
    assert k1 != k3
    assert len(k1) == 64


@pytest.mark.asyncio
async def test_cache_round_trip(session):
    user = uuid4()
    messages = [{"role": "user", "content": "plan my day"}]
    response = {"choices": [{"message": {"content": "", "tool_calls": None}}]}

    assert await ai_cache.get_cached_response(session, user, "prysmai", messages, None) is None
    await ai_cache.cache_response(session, user, "prysmai", messages, None, response)
    await session.commit()

    cached = await ai_cache.get_cached_response(session, user, "prysmai", messages, None)
    assert cached is not None
    assert cached == response


@pytest.mark.asyncio
async def test_cache_miss_on_different_request(session):
    user = uuid4()
    messages_a = [{"role": "user", "content": "a"}]
    messages_b = [{"role": "user", "content": "b"}]
    await ai_cache.cache_response(session, user, "prysmai", messages_a, None, {"x": 1})
    await session.commit()
    assert await ai_cache.get_cached_response(session, user, "prysmai", messages_b, None) is None


@pytest.mark.asyncio
async def test_cache_scoped_per_user(session):
    a = uuid4()
    b = uuid4()
    messages = [{"role": "user", "content": "same"}]
    await ai_cache.cache_response(session, a, "prysmai", messages, None, {"x": 1})
    await session.commit()
    assert await ai_cache.get_cached_response(session, b, "prysmai", messages, None) is None
