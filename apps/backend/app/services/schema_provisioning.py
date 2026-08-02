from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


async def ensure_schema(engine: AsyncEngine) -> None:
    """Idempotently ensure the database has its extensions and baseline tables.

    Runs at app startup so the schema always exists and persists regardless of
    whether the postgres container's ``docker-entrypoint-initdb.d`` bootstrap ran
    (that hook is skipped when the data directory already contains a database).

    Safe to call repeatedly: ``CREATE EXTENSION IF NOT EXISTS`` and
    ``Base.metadata.create_all`` never drop or alter existing data/tables.
    """
    import app.models  # noqa: F401  # ensure every model is registered on Base

    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_tasks_trgm ON tasks USING gin "
            "(lower(title || ' ' || COALESCE(description, '')) gin_trgm_ops)"
        ))
        await conn.run_sync(lambda sync_conn: app.models.Base.metadata.create_all(sync_conn))
