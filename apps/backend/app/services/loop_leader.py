"""Cross-worker leadership + schema serialization via PostgreSQL advisory locks.

The backend owns in-process background loops (recurring expansion, notifications,
calendar pull, analytics flush/rollup, watchlist refresh, trash purge, ...). With
more than one uvicorn worker, every worker would start its own copy and duplicate
work (double reminder emails, double calendar imports, double digests). To run N
web workers safely, the workers elect a single leader at startup:

* The leader takes a SESSION-level PostgreSQL advisory lock and keeps one
  dedicated connection open for its whole process lifetime. Because the lock is
  session-scoped, it is released automatically if the worker dies, and the next
  worker to boot (or the uvicorn supervisor's worker recycle) acquires it. No TTL
  renewal or heartbeat is needed, so there is no split-brain window.
* Followers skip the loops and serve HTTP only.

Schema provisioning is serialized separately with a *blocking* advisory lock so
two workers booting at the same instant cannot race ``create_all``/``ALTER`` DDL:
the first runs the idempotent provisioning, the second waits and then finds
everything already present.

Postgres-only. On SQLite (the test suite) leadership is always granted and
provisioning is a direct call, so tests are unaffected.
"""
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

logger = logging.getLogger(__name__)

# Arbitrary distinct 32-bit keys ("PRYS" / "PRYT").
_BACKGROUND_LOCK_KEY = 0x50525953
_SCHEMA_LOCK_KEY = 0x50525954

# The leader's dedicated connection (held for the process lifetime). There is no
# "one leader" state shared across processes other than the PG lock itself.
_leader_engine = None
_leader_conn = None


def _is_postgres(url: str) -> bool:
    return url.startswith("postgresql")


async def try_acquire_background_leadership(database_url: str) -> bool:
    """Return True when this process should run the shared background loops.

    Takes a session-level advisory lock on a dedicated connection and keeps it
    open. On SQLite (tests) or a non-Postgres URL leadership is always granted.
    """
    global _leader_engine, _leader_conn
    if not _is_postgres(database_url):
        return True
    try:
        _leader_engine = create_async_engine(
            database_url, pool_size=1, max_overflow=0, pool_pre_ping=True
        )
        _leader_conn = await _leader_engine.connect()
        result = await _leader_conn.execute(
            text("SELECT pg_try_advisory_lock(:key)"), {"key": _BACKGROUND_LOCK_KEY}
        )
        acquired = bool(result.scalar())
    except Exception:
        logger.exception("background leadership check failed; running as follower")
        await release_background_leadership()
        return False

    if acquired:
        logger.info("Acquired background-loop leadership (advisory lock)")
        return True

    logger.info("Another worker owns background-loop leadership; HTTP only")
    await release_background_leadership()
    return False


async def release_background_leadership() -> None:
    """Unlock and close the leader's dedicated connection (idempotent)."""
    global _leader_engine, _leader_conn
    if _leader_conn is not None:
        try:
            await _leader_conn.execute(
                text("SELECT pg_advisory_unlock(:key)"), {"key": _BACKGROUND_LOCK_KEY}
            )
        except Exception:
            pass
        try:
            await _leader_conn.close()
        except Exception:
            pass
        _leader_conn = None
    if _leader_engine is not None:
        try:
            await _leader_engine.dispose()
        except Exception:
            pass
        _leader_engine = None


async def serialize_schema_provisioning(engine, provision) -> None:
    """Run ``provision()`` under a blocking PG advisory lock.

    Two workers booting concurrently cannot race schema DDL: the first acquires
    the lock and provisions, the second blocks until the first finishes, then
    runs its own idempotent pass (a fast no-op). On SQLite the lock is skipped.
    """
    if engine.url.get_backend_name() != "postgresql":
        await provision()
        return
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _SCHEMA_LOCK_KEY})
        try:
            await provision()
        finally:
            try:
                await conn.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _SCHEMA_LOCK_KEY}
                )
            except Exception:
                pass
