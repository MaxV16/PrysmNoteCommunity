from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    settings.database_url,
    pool_size=20,
    max_overflow=10,
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
    pool_size=5,
    max_overflow=5,
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
