"""Race-safe token revocation.

Every flow that consumes a single-use token (refresh rotation, logout, password
reset, the mobile SSO exchange) records the token's ``jti`` in
``token_blacklist``, whose ``jti`` column is unique. The original code did a
SELECT to check the ``jti`` and then a separate INSERT. Two requests carrying
the same token (several browser tabs, desktop app plus phone, or a client retry)
could both pass the SELECT and both INSERT: the loser then raised
``IntegrityError`` on ``token_blacklist_jti_key`` and the request returned a 500
instead of a clean 401, leaving the client without fresh cookies and stranding
the session. Running more than one API worker widened that window.

The insert below runs inside a SAVEPOINT, so a concurrent winner's row rolls
back only the savepoint (the request transaction and its RLS context survive)
and the violation is reported as "already revoked" instead of an exception. The
security semantics are unchanged: a replayed token is still rejected.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.token_blacklist import TokenBlacklist


async def blacklist_jti(
    session: AsyncSession,
    jti: str,
    user_id: UUID,
    expires_at: datetime | None,
) -> bool:
    """Persist a revoked ``jti``.

    Returns True when this call inserted the row, False when the ``jti`` was
    already revoked (a concurrent request won the race). Never raises on the
    unique constraint.
    """
    try:
        async with session.begin_nested():
            session.add(TokenBlacklist(jti=jti, user_id=user_id, expires_at=expires_at))
            await session.flush()
    except IntegrityError:
        return False
    return True
