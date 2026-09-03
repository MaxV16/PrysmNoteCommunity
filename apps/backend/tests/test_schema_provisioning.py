import pytest
from sqlalchemy import select, text
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


@pytest.mark.skipif(_test_engine.dialect.name != "postgresql", reason="RLS policies are PostgreSQL-only")
@pytest.mark.asyncio
async def test_team_rls_policies_do_not_self_reference_team_members():
    """Team RLS policies must not recursively query team_members.

    A policy on team_members that reads team_members in its USING clause makes
    PostgreSQL abort any query that evaluates it (for non-superuser, RLS-enforced
    roles) with "infinite recursion detected in policy for relation
    team_members" - which surfaced as HTTP 500 on GET /tasks/{id}. Membership
    checks must go through the SECURITY DEFINER is_team_member helper instead.
    """
    await ensure_schema(_test_engine)

    async with _test_engine.begin() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT tablename, qual FROM pg_policies "
                    "WHERE schemaname = 'public' AND policyname = 'team_isolation' "
                    "ORDER BY tablename"
                )
            )
        ).all()

    assert rows, "team_isolation policies must be provisioned"
    for tablename, qual in rows:
        assert qual is not None, f"policy on {tablename} has no USING clause"
        assert "from team_members" not in qual.lower(), (
            f"policy on {tablename} must not self-reference team_members: {qual}"
        )


@pytest.mark.skipif(_test_engine.dialect.name != "postgresql", reason="RLS policies are PostgreSQL-only")
@pytest.mark.asyncio
async def test_user_isolation_policies_recreated_for_forced_tables():
    """Every FORCE-RLS table must regain its policy after ensure_schema.

    tags/task_tags are in the FORCE-RLS set, so a database whose policies were
    dropped (e.g. a test suite's policy teardown against a dev DB) would leave
    them RLS-FORCE'd with no policy - every tag write then fails with a
    "new row violates row-level security policy" error. ensure_schema must
    recreate them (the old provisioning omitted tags/task_tags).
    """
    async with _test_engine.begin() as conn:
        await conn.execute(text("DROP POLICY IF EXISTS user_isolation ON tags"))
        await conn.execute(text("DROP POLICY IF EXISTS user_isolation ON task_tags"))

    await ensure_schema(_test_engine)

    async with _test_engine.begin() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT tablename FROM pg_policies "
                    "WHERE schemaname = 'public' AND policyname = 'user_isolation' "
                    "AND tablename IN ('tags', 'task_tags') "
                    "ORDER BY tablename"
                )
            )
        ).all()

    assert {r[0] for r in rows} == {"tags", "task_tags"}, (
        "ensure_schema must recreate the user_isolation policy on tags and task_tags"
    )
