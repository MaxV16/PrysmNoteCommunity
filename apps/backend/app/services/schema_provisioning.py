from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine


async def ensure_schema(engine: AsyncEngine) -> None:
    """Idempotently ensure the database has its extensions and baseline tables.

    Runs at app startup so the schema always exists and persists regardless of
    whether the postgres container's ``docker-entrypoint-initdb.d`` bootstrap ran
    (that hook is skipped when the data directory already contains a database).

    Safe to call repeatedly: ``CREATE EXTENSION IF NOT EXISTS`` and
    ``Base.metadata.create_all`` never drop or alter existing data/tables.

    The app may connect as a non-superuser role (so PostgreSQL RLS is enforced
    rather than bypassed). Extensions and the full-text index are provisioned by
    the admin role, so privilege errors on those idempotent statements are
    tolerated — they already exist on a provisioned database. Each privileged
    statement runs in its own transaction so a permission failure cannot poison
    a shared transaction (which would abort the remaining DDL).

    Ordering matters: extensions (pgvector, pgcrypto, pg_trgm) must exist before
    ``create_all`` (vector columns), and the trigram index needs the ``tasks``
    table, so it runs after ``create_all``. That also lets a database whose
    tables were dropped (e.g. wiped test runs) self-heal on startup.
    """
    import app.models  # noqa: F401  # ensure every model is registered on Base

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

    # Column additions on pre-existing tables (create_all cannot alter existing
    # tables). Idempotent + privilege-tolerant, like the statements below.
    for _stmt in (
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
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
        "CREATE INDEX IF NOT EXISTS ix_token_blacklist_expires ON token_blacklist (expires_at)",
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


