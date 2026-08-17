from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def set_rls_user_id(session: AsyncSession, user_id: UUID) -> None:
    # set_config(text, text, is_local=true) is the parameterized, transaction-
    # scoped equivalent of `SET LOCAL app.user_id = '...'` — asyncpg cannot
    # bind parameters inside a SET statement, and interpolating would be unsafe.
    await session.execute(
        text("SELECT set_config('app.user_id', :user_id, true)").bindparams(
            user_id=str(user_id)
        ),
    )