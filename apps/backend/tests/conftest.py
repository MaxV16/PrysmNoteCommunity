import asyncio
from uuid import uuid4 as _gen_uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.main import app
from app.database import get_db
from app.models.base import Base
from app.dependencies import get_current_user
from app.models.user import User

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
_test_session_factory = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)


# Make PostgreSQL-only types work with SQLite test database
@event.listens_for(Base.metadata, "before_create")
def _adjust_for_sqlite(target, connection, **kw):
    for table in target.tables.values():
        for col in table.columns:
            # Replace JSONB with JSON for SQLite compatibility
            if isinstance(col.type, JSONB):
                col.type = JSON()
            # Replace server_default=func.gen_random_uuid() — not supported by SQLite
            sd = col.server_default
            if sd is not None and sd.arg is not None:
                raw = str(sd.arg.compile(dialect=connection.dialect))
                if "gen_random_uuid" in raw:
                    col.server_default = None
                    col.default = _gen_uuid


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def _get_test_db():
    async with _test_session_factory() as session:
        try:
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
async def test_user(db_session: AsyncSession) -> User:
    user = User(
        id=uuid4(),
        email="test@example.com",
        password_hash="fake_hash_for_testing",
        display_name="Test User",

    )
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def client(test_user: User):
    app.dependency_overrides[get_db] = _get_test_db

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()
