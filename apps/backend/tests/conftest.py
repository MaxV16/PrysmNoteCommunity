import os
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool, StaticPool

from app.main import app
from app.database import get_db
from app.models.base import Base
from app.dependencies import get_current_user
from app.models.user import User

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "sqlite+aiosqlite:///:memory:",
)

# When falling back to an in-memory SQLite database, every connection must share
# the SAME underlying database, otherwise each new connection gets an empty
# database and "no such table" errors. NullPool + :memory: creates a fresh empty
# DB per connection, so use a StaticPool so the table schema created in setup_db
# is visible to the session/request connections.
_pool_class = NullPool if "postgres" in TEST_DATABASE_URL else StaticPool
_engine_kwargs = {}
if _pool_class is StaticPool:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False, poolclass=_pool_class, **_engine_kwargs)
_test_session_factory = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)


@event.listens_for(_test_engine.sync_engine, "connect")
def _sqlite_connect_functions(dbapi_conn, record):
    """SQLite lacks PostgreSQL's gen_random_uuid(); register a compatible one so
    the SQLite test database can satisfy the models' server_default. Returns
    dash-less hex so it matches the ``Uuid(as_uuid=True)`` bind format — otherwise
    server-default-generated ids (dashed) can never be matched/updated by the ORM
    (which binds dash-less hex), making any id-based lookup fail on SQLite."""
    if _test_engine.dialect.name != "postgresql":
        try:
            import sqlite3
            from uuid import uuid4 as _uuid4

            def _gen_random_uuid():
                return _uuid4().hex

            dbapi_conn.create_function("gen_random_uuid", 0, _gen_random_uuid)
        except Exception:
            pass


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    async with _test_engine.begin() as conn:
        if _test_engine.dialect.name == "postgresql":
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


_current_test_user_id = None


@pytest_asyncio.fixture(autouse=True)
async def _reset_auth_state():
    # Rate-limiting / blacklist state is module-global and keyed on the client IP,
    # which is constant across tests. Reset it so one test's rate-limit doesn't
    # spill into the next.
    from app.routers import auth as auth_module
    auth_module._IP_BLOCKLIST.clear()
    auth_module._FAILED_LOGINS.clear()
    yield


@pytest_asyncio.fixture(autouse=True)
async def _disable_csrf_for_tests():
    # CSRF is enabled in production/dev (the frontend sends X-CSRF-Token). Tests
    # that drive the raw API would otherwise need the header on every unsafe
    # call, so disable the middleware by default; the dedicated CSRF tests (in
    # test_csrf.py) re-enable it and assert the 403 behavior explicitly.
    from app.config import settings

    original = settings.csrf_enabled
    settings.csrf_enabled = False
    yield
    settings.csrf_enabled = original


@pytest_asyncio.fixture(autouse=True)
async def _disable_api_rate_limit_for_tests():
    # The global per-IP /api limiter uses a shared in-memory counter when Redis
    # is absent; the whole suite would trip a 120/min limit over its lifetime.
    # Disable it here; test_ratelimit.py re-enables it with a tiny threshold.
    from app.config import settings

    original = settings.api_rate_limit_enabled
    original_per_min = settings.api_rate_limit_per_min
    settings.api_rate_limit_enabled = False
    settings.api_rate_limit_per_min = 120
    yield
    settings.api_rate_limit_enabled = original
    settings.api_rate_limit_per_min = original_per_min


@pytest_asyncio.fixture(autouse=True)
async def _force_memory_rate_limit():
    # Deterministic tests: CI has no Redis container and local dev has one, so
    # force every limiter onto its in-memory fallback (the same path CI runs).
    # test_ratelimit.py re-enables the Redis path with a stub when it needs to.
    import app.utils.ratelimit as rl_mod

    rl_mod._redis_checked = True
    rl_mod._redis_client = None
    yield


@pytest_asyncio.fixture(autouse=True)
async def _disable_email_for_tests():
    # No mailer is configured (or reachable) in tests — send_email should no-op
    # and return False rather than attempt real sends. Clear any env-based key.
    from app.config import settings

    original_key = settings.brevo_api_key
    original_smtp = settings.smtp_host
    settings.brevo_api_key = ""
    settings.smtp_host = ""
    yield
    settings.brevo_api_key = original_key
    settings.smtp_host = original_smtp


async def _get_test_db():
    async with _test_session_factory() as session:
        try:
            if _test_engine.dialect.name == "postgresql" and _current_test_user_id:
                from app.utils.rls import set_rls_user_id
                await session.execute(text("SELECT 1"))
                await set_rls_user_id(session, _current_test_user_id)
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


@pytest_asyncio.fixture
async def db_session():
    async with _test_session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def ai_user(db_session: AsyncSession):
    # Creates a real User for the AI-service tests (FK + RLS require a
    # matching users row) and sets RLS to that user for the session.
    from app.models.user import User
    uid = uuid4()
    user = User(id=uid, email=f"{uid}@ai.test", password_hash="fake", display_name="AI Test")
    db_session.add(user)
    await db_session.flush()
    if _test_engine.dialect.name == "postgresql":
        from app.utils.rls import set_rls_user_id
        await set_rls_user_id(db_session, uid)
    yield uid
    await db_session.rollback()


@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession) -> User:
    user = User(
        id=uuid4(),
        email="test@example.com",
        password_hash="fake_hash_for_testing",
        display_name="Test User",

    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest_asyncio.fixture
async def client(test_user: User):
    global _current_test_user_id
    _current_test_user_id = test_user.id

    app.dependency_overrides[get_db] = _get_test_db

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def auth_client():
    # Real auth flow: override only get_db (test DB), keep the app's real
    # get_current_user so registration/login/cookies/protected-route behaviour
    # works end to end.
    global _current_test_user_id
    _current_test_user_id = None

    app.dependency_overrides[get_db] = _get_test_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()
    _current_test_user_id = None


def pytest_configure(config):
    config.option.asyncio_mode = "auto"
