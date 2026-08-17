import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import _test_engine
from app.models.user import User
from app.services.schema_provisioning import ensure_schema


@pytest.mark.asyncio
async def test_ensure_schema_is_idempotent_and_preserves_data(db_session: AsyncSession):
    """Running ensure_schema must be safe to call repeatedly and never drop data."""
    await ensure_schema(_test_engine)

    user = User(
        email="schema-test@example.com",
        password_hash="hash",
        display_name="Schema Test",
    )
    db_session.add(user)
    await db_session.commit()
    user_id = user.id

    # Running it again (as the app does on every startup) must not wipe the row.
    await ensure_schema(_test_engine)

    fetched = await db_session.get(User, user_id)
    assert fetched is not None
    assert fetched.email == "schema-test@example.com"

    # And the users table must exist.
    exists = await db_session.execute(select(User.id).limit(1))
    assert exists.first() is not None
