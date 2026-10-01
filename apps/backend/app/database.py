from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    settings.database_url,
    # Sized for the multi-worker prod stack: each uvicorn worker owns its own
    # pool, so 6+4 (max 10) per worker stays well under Postgres max_connections
    # even with 2 web workers plus the leader's dedicated connection.
    pool_size=6,
    max_overflow=4,
    pool_pre_ping=True,
    echo=False,
)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# System/background engine. These jobs (recurring-task expansion, calendar pull)
# process data across ALL users and have no per-request auth context, so they
# connect through a non-superuser BYPASSRLS role that is exempt from RLS. The
# request path keeps using `async_session_factory` (RLS enforced). Falls back to
# the request URL so unconfigured environments (e.g. CI) still work.
system_engine = create_async_engine(
    settings.system_database_url or settings.database_url,
    pool_size=4,
    max_overflow=2,
    pool_pre_ping=True,
    echo=False,
)
system_session_factory = async_sessionmaker(system_engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def get_system_db():
    """BYPASSRLS session for lookups that must happen BEFORE a user context exists.

    Used by the public passkey sign-in endpoint to find a credential by id (the
    credential owner is unknown until the lookup succeeds, so the row-level
    policy cannot be satisfied yet). The BYPASSRLS ``prysm_system`` role is also
    what the background loops use; the app-layer code still filters by the
    authenticated user for every management operation.
    """
    async with system_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
