import os
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.main import app
from app.database import get_db
from app.models.base import Base
from app.dependencies import get_current_user
from app.models.user import User

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "sqlite+aiosqlite:///:memory:",
)

_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False, poolclass=NullPool)
_test_session_factory = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    async with _test_engine.begin() as conn:
        if _test_engine.dialect.name == "postgresql":
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
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
