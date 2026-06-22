from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def set_rls_user_id(session: AsyncSession, user_id: UUID) -> None:
    await session.execute(
        text(f"SET LOCAL app.user_id = '{str(user_id)}'").execution_options(autocommit=True),
    )