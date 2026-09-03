"""AI entitlement + usage-accounting tests (core).

Verifies the community default (BYOK, unlimited), the hosted PrysmAI allowance
gating, and monthly usage summation - the cost-control heart of the hosted AI.
"""
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.models.base import Base
import app.models  # noqa: F401  # register all core models (incl. ai_usage)

from app.services import ai_entitlement


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


@pytest.mark.asyncio
async def test_record_and_sum_monthly_usage(session):
    user_id = uuid4()
    await ai_entitlement.record_ai_usage(session, user_id, "prysmai", 100, 50, cached_input_tokens=10)
    await ai_entitlement.record_ai_usage(session, user_id, "prysmai", 200, 100, cached_input_tokens=20)
    await session.commit()

    total = await ai_entitlement.monthly_usage(session, user_id, "prysmai")
    assert total == 100 + 50 + 10 + 200 + 100 + 20


@pytest.mark.asyncio
async def test_usage_is_scoped_per_user(session):
    a = uuid4()
    b = uuid4()
    await ai_entitlement.record_ai_usage(session, a, "prysmai", 999, 0)
    await ai_entitlement.record_ai_usage(session, b, "prysmai", 1, 1)
    await session.commit()
    assert await ai_entitlement.monthly_usage(session, a, "prysmai") == 999
    assert await ai_entitlement.monthly_usage(session, b, "prysmai") == 2


def test_parse_usage_extracts_tokens():
    resp = {
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 30,
            "prompt_tokens_details": {"cached_tokens": 80},
        }
    }
    u = ai_entitlement.parse_usage(resp)
    assert u == {"input": 120, "output": 30, "cached_input": 80}


def test_parse_usage_defaults_on_missing():
    assert ai_entitlement.parse_usage({}) == {"input": 0, "output": 0, "cached_input": 0}


@pytest.mark.asyncio
async def test_check_allowance_default_is_byok_unlimited(session):
    # No EE hook registered (community build) => BYOK, never blocked.
    ent = await ai_entitlement.check_ai_allowance(str(uuid4()), session)
    assert ent["mode"] == "byok"
    assert ent["blocked"] is False
    assert ent["remaining"] is None


@pytest.mark.asyncio
async def test_check_allowance_prysmai_blocked_when_exhausted(session, monkeypatch):
    async def fake_check(user_id, sess):
        return {"mode": "prysmai", "allowance": 100, "used": 100}

    monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", fake_check)
    try:
        ent = await ai_entitlement.check_ai_allowance(str(uuid4()), session)
        assert ent["mode"] == "prysmai"
        assert ent["blocked"] is True
        assert ent["remaining"] == 0
    finally:
        monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", None)


@pytest.mark.asyncio
async def test_check_allowance_prysmai_remaining(session, monkeypatch):
    async def fake_check(user_id, sess):
        return {"mode": "prysmai", "allowance": 100, "used": 30}

    monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", fake_check)
    try:
        ent = await ai_entitlement.check_ai_allowance(str(uuid4()), session)
        assert ent["blocked"] is False
        assert ent["remaining"] == 70
    finally:
        monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", None)


@pytest.mark.asyncio
async def test_byok_allowed_defaults_true_without_gate(session):
    # No BYOK gate registered (community build) => BYOK open to everyone.
    assert await ai_entitlement.byok_allowed(str(uuid4()), session) is True


@pytest.mark.asyncio
async def test_byok_allowed_uses_registered_gate(session, monkeypatch):
    async def gate(user_id, sess):
        return user_id == "paid-user"

    monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", gate)
    try:
        assert await ai_entitlement.byok_allowed("paid-user", session) is True
        assert await ai_entitlement.byok_allowed("free-user", session) is False
    finally:
        monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", None)


@pytest.mark.asyncio
async def test_resolve_llm_key_blocks_byok_for_gated_users(session, monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.routers.ai import resolve_llm_key

    async def gate(user_id, sess):
        return False

    monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", gate)
    try:
        user = SimpleNamespace(id=uuid4())
        with pytest.raises(HTTPException) as exc:
            await resolve_llm_key(session, user, "openai")
        assert exc.value.status_code == 403
    finally:
        monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", None)


@pytest.mark.asyncio
async def test_resolve_llm_key_byok_requires_stored_key_when_allowed(session, monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.routers.ai import resolve_llm_key

    async def gate(user_id, sess):
        return True

    monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", gate)
    try:
        user = SimpleNamespace(id=uuid4())
        with pytest.raises(HTTPException) as exc:
            await resolve_llm_key(session, user, "openai")
        # Gate allows, but no stored API key -> friendly 400.
        assert exc.value.status_code == 400
    finally:
        monkeypatch.setattr(ai_entitlement, "_BYOK_GATE", None)
