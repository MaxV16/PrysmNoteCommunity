from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.embedding import TaskEmbedding
from app.models.task import Task


async def get_user_llm_client_for_embedding(session: AsyncSession, user_id: UUID):
    from app.llm.base import get_provider
    from app.utils.encryption import decrypt_api_key

    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user_id,
            ApiKey.is_active == True,
        )
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        return None
    try:
        decrypted = decrypt_api_key(api_key.encrypted_key)
        client = get_provider(api_key.provider, decrypted)
        return (api_key.provider, client)
    except Exception:
        return None


async def generate_and_store_embedding(
    session: AsyncSession,
    task_id: UUID,
    user_id: UUID,
    title: str,
    description: str | None = None,
):
    provider_info = await get_user_llm_client_for_embedding(session, user_id)
    if not provider_info:
        return None

    provider_name, client = provider_info
    text = title
    if description:
        text = f"{title}\n{description}"

    try:
        embedding = await client.embed(text)
    except Exception:
        return None

    return await store_embedding(session, task_id, embedding)


async def store_embedding(session: AsyncSession, task_id: UUID, embedding: list[float]) -> TaskEmbedding:
    result = await session.execute(
        select(TaskEmbedding).where(TaskEmbedding.task_id == task_id)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.embedding = embedding
        emb = existing
    else:
        emb = TaskEmbedding(task_id=task_id, embedding=embedding)
        session.add(emb)
    await session.flush()
    return emb


async def search_similar(
    session: AsyncSession, embedding: list[float], user_id: UUID, limit: int = 10
):
    from sqlalchemy import text
    stmt = (
        select(TaskEmbedding, TaskEmbedding.embedding.cosine_distance(embedding).label("distance"))
        .join(Task, TaskEmbedding.task_id == Task.id)
        .where(Task.user_id == user_id)
        .order_by(text("distance"))
        .limit(limit)
    )
    result = await session.execute(stmt)
    rows = []
    for row in result:
        emb, distance = row
        task_result = await session.execute(select(Task).where(Task.id == emb.task_id))
        task = task_result.scalar_one_or_none()
        if task:
            rows.append((task, float(1 - distance)))
    return rows
