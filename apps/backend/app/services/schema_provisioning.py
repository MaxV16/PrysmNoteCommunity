import logging

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


async def ensure_schema(engine: AsyncEngine, system_engine: AsyncEngine | None = None) -> None:
    """Idempotently ensure the database has its extensions and baseline tables.

    Runs at app startup so the schema always exists and persists regardless of
    whether the postgres container's ``docker-entrypoint-initdb.d`` bootstrap ran
    (that hook is skipped when the data directory already contains a database).

    Safe to call repeatedly: ``CREATE EXTENSION IF NOT EXISTS`` and
    ``Base.metadata.create_all`` never drop or alter existing data/tables.

    The app may connect as a non-superuser role (so PostgreSQL RLS is enforced
    rather than bypassed). Extensions and the full-text index are provisioned by
    the admin role, so privilege errors on those idempotent statements are
    tolerated - they already exist on a provisioned database. Each privileged
    statement runs in its own transaction so a permission failure cannot poison
    a shared transaction (which would abort the remaining DDL).

    ``system_engine`` (the BYPASSRLS ``prysm_system`` connection) is used to
    create the ``is_team_member`` SECURITY DEFINER helper that the team RLS
    policies call. A policy that queries ``team_members`` directly trips
    PostgreSQL's "infinite recursion detected in policy" planner check, so the
    membership check must run as a role exempt from RLS; SECURITY DEFINER
    functions only skip RLS when owned by such a role, hence the system engine.

    Ordering matters: extensions (pgvector, pgcrypto, pg_trgm) must exist before
    ``create_all`` (vector columns), and the trigram index needs the ``tasks``
    table, so it runs after ``create_all``. That also lets a database whose
    tables were dropped (e.g. wiped test runs) self-heal on startup.
    """
    import app.models  # noqa: F401  # ensure every model is registered on Base

    if engine.dialect.name == "postgresql":
        for _stmt in (
            "CREATE EXTENSION IF NOT EXISTS vector",
            "CREATE EXTENSION IF NOT EXISTS pgcrypto",
            "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        ):
            try:
                async with engine.begin() as _conn:
                    await _conn.execute(text(_stmt))
            except ProgrammingError as _err:
                if not _is_privilege_error(_err):
                    raise

    async with engine.begin() as conn:
        await conn.run_sync(lambda sync_conn: app.models.Base.metadata.create_all(sync_conn))

    # Grant the BYPASSRLS system role access to tables create_all creates after
    # initial provisioning. The init script (zz-init-roles.sh) only runs
    # GRANT ... ON ALL TABLES once, so tables added later (e.g. the notification
    # tables) are owned by the app role but invisible to the system role that
    # powers the background loops. Idempotent + role-existence guarded so dev
    # (no prysm_system role) and community builds are safe no-ops.
    try:
        async with engine.begin() as conn:
            role = await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = 'prysm_system'"))
            if role.scalar_one_or_none():
                await conn.execute(
                    text(
                        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
                        "user_notification_prefs, push_subscriptions, notification_logs, "
                        "notes, teams, team_members, team_invites, team_projects, task_shares, "
                        "user_preferences, board_sections, watchlist_items, "
                        "analytics_events, analytics_daily TO prysm_system"
                    )
                )
                # analytics_events uses a bigint identity PK; the BYPASSRLS
                # system role must be able to advance the sequence or inserts
                # fail with "permission denied for sequence" (PG-only; the
                # SQLite test fallback has no sequences).
                await conn.execute(
                    text(
                        "GRANT USAGE, SELECT ON SEQUENCE analytics_events_id_seq TO prysm_system"
                    )
                )
    except Exception:
        pass

    # Create the team-membership helper the RLS policies below call. The helper
    # must be SECURITY DEFINER AND owned by a BYPASSRLS role, otherwise the
    # membership query re-enters the team_members policy and PostgreSQL aborts
    # with "infinite recursion detected in policy". The system engine connects
    # as prysm_system (BYPASSRLS), so the function it creates owns that
    # exemption. Falls back to the app engine for unusual deployments (the
    # function then cannot bypass RLS and legacy behaviour is preserved).
    helper_created = False
    for _helper_engine in (system_engine, engine):
        if _helper_engine is None:
            continue
        if _helper_engine.dialect.name != "postgresql":
            continue
        try:
            async with _helper_engine.begin() as _conn:
                await _conn.execute(text("DROP FUNCTION IF EXISTS is_team_member(UUID, UUID) CASCADE"))
                await _conn.execute(
                    text(
                        "CREATE FUNCTION is_team_member(p_team_id UUID, p_user_id UUID) RETURNS BOOLEAN "
                        "LANGUAGE SQL SECURITY DEFINER SET search_path = public SET row_security = off "
                        "STABLE AS $$ SELECT EXISTS ("
                        "  SELECT 1 FROM team_members tm WHERE tm.team_id = p_team_id AND tm.user_id = p_user_id) $$"
                    )
                )
                await _conn.execute(text("GRANT EXECUTE ON FUNCTION is_team_member(UUID, UUID) TO PUBLIC"))
            helper_created = True
            break
        except Exception:
            logger.exception("is_team_member helper creation via %s failed", "system engine" if _helper_engine is system_engine else "app engine")

    if not helper_created:
        logger.warning("is_team_member helper unavailable - skipping team RLS provisioning")
        return

    # Recreate the tasks RLS policy so team-shared tasks are readable/writable by
    # the sharing team's members (cross-user collaboration), plus enable RLS on
    # the team/note tables created by create_all. All of this must run AFTER
    # create_all (the teams policy references team_members, which doesn't exist
    # while the tables are being created). Idempotent; PostgreSQL only; no-op on
    # privilege errors / SQLite. Each tuple entry is ONE statement (asyncpg
    # rejects multiple commands in a single execute).
    rls_statements = (
        "CREATE OR REPLACE FUNCTION rls_user_id() RETURNS UUID AS $$ "
        "SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID; $$ LANGUAGE SQL STABLE",
        "CREATE OR REPLACE FUNCTION rls_user_email() RETURNS TEXT AS $$ "
        "SELECT NULLIF(current_setting('app.user_email', TRUE), ''); $$ LANGUAGE SQL STABLE",
        # tasks - own tasks or tasks shared with a team the user belongs to
        "DROP POLICY IF EXISTS user_isolation ON tasks",
        "CREATE POLICY user_isolation ON tasks "
        "USING (user_id = rls_user_id() OR EXISTS ("
        "  SELECT 1 FROM task_shares ts "
        "  WHERE ts.task_id = tasks.id AND is_team_member(ts.team_id, rls_user_id()))) "
        "WITH CHECK (user_id = rls_user_id() OR EXISTS ("
        "  SELECT 1 FROM task_shares ts2 "
        "  WHERE ts2.task_id = tasks.id AND is_team_member(ts2.team_id, rls_user_id())))",
        # tags / task_tags - user-scoped baseline tables. These are in the
        # FORCE-RLS set below, so a DB that lost their policies (e.g. a test
        # suite's policy teardown against a dev DB) must have them recreated on
        # every startup, or every tag write fails with an RLS violation.
        "DROP POLICY IF EXISTS user_isolation ON tags",
        "CREATE POLICY user_isolation ON tags "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
        "DROP POLICY IF EXISTS user_isolation ON task_tags",
        "CREATE POLICY user_isolation ON task_tags "
        "USING (task_id IN (SELECT id FROM tasks WHERE user_id = rls_user_id())) "
        "WITH CHECK (task_id IN (SELECT id FROM tasks WHERE user_id = rls_user_id()))",
        # notes - user-scoped
        "ALTER TABLE notes ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE notes FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS user_isolation ON notes",
        "CREATE POLICY user_isolation ON notes "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
        # teams - owner or any member
        "ALTER TABLE teams ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE teams FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS team_isolation ON teams",
        "CREATE POLICY team_isolation ON teams "
        "USING (teams.owner_id = rls_user_id() OR is_team_member(teams.id, rls_user_id())) "
        "WITH CHECK (teams.owner_id = rls_user_id() OR is_team_member(teams.id, rls_user_id()))",
        # team_members - the user or anyone in the same team
        "ALTER TABLE team_members ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE team_members FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS team_isolation ON team_members",
        "CREATE POLICY team_isolation ON team_members "
        "USING (team_members.user_id = rls_user_id() OR is_team_member(team_members.team_id, rls_user_id())) "
        "WITH CHECK (team_members.user_id = rls_user_id() OR is_team_member(team_members.team_id, rls_user_id()))",
        # team_invites - inviter, team member, or the invited email
        "ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE team_invites FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS team_isolation ON team_invites",
        "CREATE POLICY team_isolation ON team_invites "
        "USING (team_invites.invited_by = rls_user_id() OR is_team_member(team_invites.team_id, rls_user_id()) "
        "OR LOWER(team_invites.email) = LOWER(rls_user_email())) "
        "WITH CHECK (team_invites.invited_by = rls_user_id() OR is_team_member(team_invites.team_id, rls_user_id()) "
        "OR LOWER(team_invites.email) = LOWER(rls_user_email()))",
        # team_projects - team member
        "ALTER TABLE team_projects ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE team_projects FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS team_isolation ON team_projects",
        "CREATE POLICY team_isolation ON team_projects "
        "USING (is_team_member(team_projects.team_id, rls_user_id())) "
        "WITH CHECK (is_team_member(team_projects.team_id, rls_user_id()))",
        # task_shares - sharer or team member
        "ALTER TABLE task_shares ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE task_shares FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS team_isolation ON task_shares",
        "CREATE POLICY team_isolation ON task_shares "
        "USING (task_shares.shared_by = rls_user_id() OR is_team_member(task_shares.team_id, rls_user_id())) "
        "WITH CHECK (task_shares.shared_by = rls_user_id() OR is_team_member(task_shares.team_id, rls_user_id()))",
        # user_preferences - user-scoped key/value prefs
        "ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS user_isolation ON user_preferences",
        "CREATE POLICY user_isolation ON user_preferences "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
        # board_sections - user-scoped board column definitions
        "ALTER TABLE board_sections ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE board_sections FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS user_isolation ON board_sections",
        "CREATE POLICY user_isolation ON board_sections "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
        # watchlist_items - user-scoped shows & movies tracking
        "ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE watchlist_items FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS user_isolation ON watchlist_items",
        "CREATE POLICY user_isolation ON watchlist_items "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
        # analytics_events - user-scoped first-party analytics. Mirrors the
        # tags/task_tags correction: ensure_schema must recreate the policy on
        # every startup, or a DB that lost it (e.g. a test-suite policy teardown
        # against a dev DB) leaves every analytics read/write failing RLS.
        "ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE analytics_events FORCE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS user_isolation ON analytics_events",
        "CREATE POLICY user_isolation ON analytics_events "
        "USING (user_id = rls_user_id()) WITH CHECK (user_id = rls_user_id())",
    )

    # FORCE row-level security on every user-scoped core table so the table
    # owner (prysm_app) is subject to the policies too. Without FORCE the owner
    # bypasses RLS entirely and the backstop the runbook advertises does not
    # exist (H1). Each table already has a user_isolation policy from init.sql;
    # FORCE turns it on for the owning role.
    #
    # EXCLUDED on purpose:
    #  - users: it is the auth identity table. login/registration/OAuth-linking
    #    read by email across ALL users before any app.user_id session variable
    #    exists, so FORCE with the current policy (id = rls_user_id()) breaks
    #    sign-in entirely. teams.py also reads other members' emails. Auth-side
    #    app-layer filters are the boundary here.
    #  - token_blacklist: jti lookups run before/without a user context
    #    (get_current_user checks a jti before the RLS var is set); it holds no
    #    cross-user data worth isolating.
    #  - ai_cache/ai_usage/ai_memories, notification tables and the EE tables
    #    are already FORCE'd by their own after_create handlers.
    force_rls_tables = (
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
        "watchlist_items",
        "analytics_events",
    )
    # ENABLE + FORCE as a pair: FORCE alone does not enable RLS on a table that
    # was created by create_all without an init.sql baseline (e.g. the test
    # schema or community deployments) - relrowsecurity stays off and the
    # policies stay inert. Each statement is separate (asyncpg rejects multiple
    # commands in one execute).
    force_statements = tuple(
        f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY" for t in force_rls_tables
    ) + tuple(
        f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY" for t in force_rls_tables
    )
    try:
        async with engine.begin() as conn:
            if conn.dialect.name == "postgresql":
                for stmt in rls_statements + force_statements:
                    await conn.execute(text(stmt))
    except Exception:
        logger.exception("team/note RLS provisioning failed (teams/notes stay unprotected)")

    # Column additions on pre-existing tables (create_all cannot alter existing
    # tables). Idempotent + privilege-tolerant, like the statements below.
    for _stmt in (
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
        # Email verification: existing accounts are grandfathered as verified.
        # New rows are inserted with email_verified=False explicitly by the app.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE",
        # Board placement on existing tasks tables (create_all cannot alter them).
        # The FK reference makes ON DELETE SET NULL work on databases where the
        # column is added here rather than via alembic 0011.
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_section_id UUID REFERENCES board_sections(id) ON DELETE SET NULL",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_order INTEGER",
        # Recurring-template expansion cooldown + calendar pull timestamps
        # (idempotent; mirrored by alembic 0012).
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_last_expanded_at TIMESTAMPTZ",
        "ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS last_pulled_at TIMESTAMPTZ",
        # Task time slots for AI-captured clock times ("at 2pm") and timeline
        # ordering (idempotent; mirrored by alembic 0015). Naive HH:MM, no tz.
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_time TIME",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_time TIME",
        # Theatrical-release flag for watchlist movies (create_all cannot alter).
        "ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS is_theatrical BOOLEAN NOT NULL DEFAULT FALSE",
        # Import batch tracking for undo (create_all cannot alter; mirrored by
        # alembic 0014). Null for everything created outside import.
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS import_batch_id UUID",
        "ALTER TABLE notes ADD COLUMN IF NOT EXISTS import_batch_id UUID",
    ):
        try:
            async with engine.begin() as _conn:
                await _conn.execute(text(_stmt))
        except ProgrammingError as _err:
            if not _is_privilege_error(_err):
                raise

    # Indexes that materially speed up hot queries. create_all won't add these to
    # tables that already exist, so they are provisioned explicitly (idempotent,
    # privilege-tolerant like the statements above). Keep expressions in sync
    # with the queries that use them (e.g. pg_trgm operands must match exactly).
    for _stmt in (
        # pg_trgm search: the query matches lower(title) and
        # lower(coalesce(description, '')) with the % operator, so the index
        # expressions must be identical for the planner to use them.
        "CREATE INDEX IF NOT EXISTS ix_tasks_title_trgm ON tasks USING gin (lower(title) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_tasks_desc_trgm ON tasks USING gin (lower(coalesce(description, '')) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_tasks_user_created ON tasks (user_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_habit_logs_habit_date ON habit_logs (habit_id, completed_at)",
        "CREATE INDEX IF NOT EXISTS ix_ai_conversations_user_session ON ai_conversations (user_id, session_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_ai_sessions_user_session ON ai_sessions (user_id, session_id)",
        "CREATE INDEX IF NOT EXISTS ix_ai_memories_user_active ON ai_memories (user_id, is_active)",
        "CREATE INDEX IF NOT EXISTS ix_user_tokens_provider ON user_tokens (provider)",
        "CREATE INDEX IF NOT EXISTS ix_calendar_events_user_google ON calendar_events (user_id, google_event_id)",
        "CREATE INDEX IF NOT EXISTS ix_tasks_board_section ON tasks (user_id, board_section_id, board_order)",
        "CREATE INDEX IF NOT EXISTS ix_token_blacklist_expires ON token_blacklist (expires_at)",
        # Import-batch lookups for the undo endpoint (backed by the model's
        # own Index declarations so a fresh create_all DB matches exactly).
        "CREATE INDEX IF NOT EXISTS idx_tasks_user_import_batch ON tasks (user_id, import_batch_id)",
        "CREATE INDEX IF NOT EXISTS idx_notes_user_import_batch ON notes (user_id, import_batch_id)",
        # pgvector approximate nearest-neighbor search for semantic task search.
        "CREATE INDEX IF NOT EXISTS ix_task_embeddings_hnsw ON task_embeddings USING hnsw (embedding vector_cosine_ops)",
        "CREATE INDEX IF NOT EXISTS ix_ai_memories_hnsw ON ai_memories USING hnsw (embedding vector_cosine_ops)",
        # The original single-column-concatenation index never matched the search
        # operands and was dead weight on writes; drop it if still present.
        "DROP INDEX IF EXISTS ix_tasks_trgm",
    ):
        try:
            async with engine.begin() as _conn:
                await _conn.execute(text(_stmt))
        except ProgrammingError as _err:
            if not _is_privilege_error(_err):
                raise


def _is_privilege_error(err: ProgrammingError) -> bool:
    """True when the error is a missing privilege/ownership (vs a real failure).

    A non-superuser app role cannot create extensions or indexes on admin-owned
    tables, but these are already provisioned, so they can be safely skipped.
    """
    text = str(err).lower()
    return "must be owner" in text or "permission denied" in text or "insufficient privilege" in text


