import asyncio
import hashlib
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.embedding import TaskEmbedding
from app.models.task import Task

# Bounds how many embedding provider calls ever overlap. Embeddings are
# fire-and-forget, but an import or a burst of edits must not fan out an
# unbounded number of concurrent requests.
_EMBED_SEMAPHORE = asyncio.Semaphore(2)


def _embedding_text(title: str, description: str | None) -> str:
    if description:
        return f"{title}\n{description}"
    return title


def _source_hash(title: str, description: str | None) -> str:
    return hashlib.sha256(_embedding_text(title, description).encode("utf-8")).hexdigest()


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
    # No usable AI path (free tier with no key and no hosted entitlement): skip
    # before touching the provider or the api_keys table.
    from app.services.ai_entitlement import get_ai_mode

    try:
        if (await get_ai_mode(user_id, session)).get("mode") == "none":
            return None
    except Exception:
        # Fail-open: an entitlement lookup failure must not block BYOK embeddings.
        pass

    provider_info = await get_user_llm_client_for_embedding(session, user_id)
    if not provider_info:
        return None

    text = _embedding_text(title, description)
    source_hash = _source_hash(title, description)

    # Unchanged text already has an embedding: skip the provider call entirely.
    existing_result = await session.execute(
        select(TaskEmbedding).where(TaskEmbedding.task_id == task_id)
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None and existing.source_hash == source_hash:
        return existing

    provider_name, client = provider_info

    async with _EMBED_SEMAPHORE:
        try:
            embedding = await client.embed(text)
        except Exception:
            return None

    return await store_embedding(session, task_id, embedding, source_hash)


async def store_embedding(
    session: AsyncSession,
    task_id: UUID,
    embedding: list[float],
    source_hash: str | None = None,
) -> TaskEmbedding:
    result = await session.execute(
        select(TaskEmbedding).where(TaskEmbedding.task_id == task_id)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.embedding = embedding
        if source_hash is not None:
            existing.source_hash = source_hash
        emb = existing
    else:
        emb = TaskEmbedding(task_id=task_id, embedding=embedding, source_hash=source_hash)
        session.add(emb)
    await session.flush()
    return emb


async def search_similar(
    session: AsyncSession, embedding: list[float], user_id: UUID, limit: int = 10
):
    from sqlalchemy import text
    # Join Task in the same statement (the previous per-row re-fetch was an N+1).
    stmt = (
        select(
            TaskEmbedding,
            Task,
            TaskEmbedding.embedding.cosine_distance(embedding).label("distance"),
        )
        .join(Task, TaskEmbedding.task_id == Task.id)
        .where(Task.user_id == user_id, Task.deleted_at.is_(None))
        .order_by(text("distance"))
        .limit(limit)
    )
    result = await session.execute(stmt)
    rows = []
    for row in result:
        _emb, task, distance = row
        rows.append((task, float(1 - distance)))
    return rows
