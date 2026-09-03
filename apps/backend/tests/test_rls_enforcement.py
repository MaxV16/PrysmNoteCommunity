"""RLS enforcement regression tests (PostgreSQL only).

Provisions the production RLS shape (policies + FORCE) with ``ensure_schema``
and asserts that a cross-user SELECT on a FORCE'd table returns zero rows - i.e.
the table owner (``prysm_app``) no longer bypasses row-level security (H1).

The tests connect as a NON-superuser, NOBYPASSRLS role (``prysm_app``) exactly
like production. Running them as the superuser would silently pass because
superusers bypass RLS no matter what FORCE says.

SQLite is skipped: SQLite has no RLS, so these tests would silently pass there
(which is exactly why the RLS gap went unnoticed - see the audit).
"""
import os
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.models.task import Task
from app.models.teams import Team, TeamMember, TaskShare
from app.models.user import User
from app.services.schema_provisioning import ensure_schema
from app.utils.rls import set_rls_user_id

TEST_URL = os.getenv("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
IS_PG = TEST_URL.startswith("postgresql")

APP_ROLE = "prysm_app"
APP_PASSWORD = "prysm_app_test_password"

pytestmark = pytest.mark.skipif(not IS_PG, reason="RLS enforcement is PostgreSQL-only")


async def _provision_app_role_and_ownership(engine):
    """Create the non-superuser app role (if absent) and hand it ownership of
    the public tables - mirroring zz-init-roles.sh, which is what makes the
    owner-bypass real (and FORCE the fix for it)."""
    async with engine.begin() as conn:
        await conn.execute(text(
            f"DO $$ BEGIN "
            f"IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN "
            f"CREATE ROLE {APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{APP_PASSWORD}'; "
            f"END IF; END $$;"
        ))
        await conn.execute(text(f"GRANT CONNECT ON DATABASE {_dbname(TEST_URL)} TO {APP_ROLE}"))
        await conn.execute(text(f"GRANT USAGE, CREATE ON SCHEMA public TO {APP_ROLE}"))
        await conn.execute(text(
            "DO $$ DECLARE r RECORD; BEGIN "
            "FOR r IN SELECT 'ALTER TABLE ' || quote_ident(schemaname) || '.' || quote_ident(tablename) || ' OWNER TO " + APP_ROLE + "' AS q "
            "  FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE r.q; END LOOP; "
            "END $$;"
        ))


def _dbname(url: str) -> str:
    return url.split("/")[-1]


def _app_url() -> str:
    return TEST_URL.replace(
        TEST_URL.split("@")[0],
        f"postgresql+asyncpg://{APP_ROLE}:{APP_PASSWORD}",
    )


@pytest.mark.asyncio
async def test_cross_user_select_returns_zero_rows_on_forced_table():
    admin_engine = create_async_engine(TEST_URL, poolclass=NullPool)
    try:
        await ensure_schema(admin_engine, admin_engine)
        await _provision_app_role_and_ownership(admin_engine)

        app_engine = create_async_engine(_app_url(), poolclass=NullPool)
        factory = async_sessionmaker(app_engine, expire_on_commit=False)

        async with factory() as setup:
            user_a = User(id=uuid4(), email="rls-a@test", password_hash="fake")
            user_b = User(id=uuid4(), email="rls-b@test", password_hash="fake")
            setup.add_all([user_a, user_b])
            await setup.flush()
            await set_rls_user_id(setup, user_a.id)
            setup.add(Task(user_id=user_a.id, title="A's private task"))
            await setup.commit()

        # The owner row is visible to its owner...
        async with factory() as s:
            await set_rls_user_id(s, user_a.id)
            own = (await s.execute(select(Task).where(Task.user_id == user_a.id))).scalars().all()
            assert len(own) == 1

        # ...but a different user sees ZERO rows, even though the same DB role
        # (the table owner) performs the query. Without FORCE this returns the
        # row because table owners bypass RLS (the H1 gap).
        async with factory() as s:
            await set_rls_user_id(s, user_b.id)
            cross = (await s.execute(select(Task))).scalars().all()
            assert cross == []
            cross_by_id = (
                await s.execute(select(Task).where(Task.id == own[0].id))
            ).scalars().all()
            assert cross_by_id == []

        # Cross-user INSERT is rejected by the WITH CHECK policy.
        async with factory() as s:
            await set_rls_user_id(s, user_a.id)
            s.add(Task(user_id=user_b.id, title="forged cross-user task"))
            with pytest.raises(Exception):
                await s.flush()
            await s.rollback()
        await app_engine.dispose()
    finally:
        await admin_engine.dispose()


@pytest.mark.asyncio
async def test_team_shared_task_readable_by_team_member_under_force():
    """The tasks policy must still let a team member read a shared task when RLS
    is FORCE'd (mirrors the get_task_shares pattern in teams.py)."""
    admin_engine = create_async_engine(TEST_URL, poolclass=NullPool)
    try:
        await ensure_schema(admin_engine, admin_engine)
        await _provision_app_role_and_ownership(admin_engine)

        app_engine = create_async_engine(_app_url(), poolclass=NullPool)
        factory = async_sessionmaker(app_engine, expire_on_commit=False)

        async with factory() as setup:
            owner = User(id=uuid4(), email="team-owner@test", password_hash="fake")
            member = User(id=uuid4(), email="team-member@test", password_hash="fake")
            setup.add_all([owner, member])
            await setup.flush()
            await set_rls_user_id(setup, owner.id)
            task = Task(user_id=owner.id, title="Shared task")
            setup.add(task)
            await setup.flush()
            team = Team(owner_id=owner.id, name="Team RLS")
            setup.add(team)
            await setup.flush()
            setup.add_all(
                [
                    TeamMember(team_id=team.id, user_id=owner.id, role="owner"),
                    TeamMember(team_id=team.id, user_id=member.id, role="member"),
                    TaskShare(task_id=task.id, team_id=team.id, shared_by=owner.id),
                ]
            )
            await setup.commit()

        # The team member can read the shared task via the team-scoped subquery
        # (the exact pattern in teams.py:446-447).
        async with factory() as s:
            await set_rls_user_id(s, member.id)
            shared_ids = select(TaskShare.task_id).where(TaskShare.team_id == team.id)
            result = await s.execute(select(Task).where(Task.id.in_(shared_ids)))
            assert len(result.scalars().all()) == 1
        await app_engine.dispose()
    finally:
        await admin_engine.dispose()


@pytest.mark.asyncio
async def test_force_is_idempotent_and_applies_to_all_core_tables():
    """FORCE must be idempotent (startup-safe) and cover every listed table."""
    engine = create_async_engine(TEST_URL, poolclass=NullPool)
    try:
        await ensure_schema(engine, engine)
        await ensure_schema(engine, engine)

        async with engine.begin() as conn:
            forced = (
                await conn.execute(
                    text(
                        "SELECT relname FROM pg_class "
                        "WHERE relkind = 'r' AND relforcerowsecurity"
                    )
                )
            ).scalars().all()

        expected = {
            "api_keys",
            "tasks",
            "task_links",
            "tags",
            "task_tags",
            "task_embeddings",
            "ai_conversations",
            "ai_sessions",
            "calendar_events",
            "user_tokens",
            "habits",
            "habit_logs",
            "user_preferences",
            "board_sections",
            "notes",
            "teams",
            "team_members",
            "team_invites",
            "team_projects",
            "task_shares",
            "analytics_events",
        }
        assert expected.issubset(set(forced)), (
            f"FORCE missing on: {expected - set(forced)}"
        )
    finally:
        await engine.dispose()
