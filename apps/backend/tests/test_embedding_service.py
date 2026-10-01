import pytest
from uuid import uuid4

from app.models.embedding import TaskEmbedding
from app.models.task import Task
import app.services.embedding_service as embedding_service


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        return [0.0] * 1536


async def _make_task(db_session, user_id) -> Task:
    task = Task(id=uuid4(), user_id=user_id, title="Original title", description="Original description")
    db_session.add(task)
    await db_session.flush()
    return task


@pytest.mark.asyncio
async def test_unchanged_task_does_not_reembed(db_session, ai_user, monkeypatch):
    """PATCHing a task without changing its text must not call the provider again."""
    from app.services import ai_entitlement

    client = _FakeClient()

    async def fake_get_client(session, user_id):
        return ("openai", client)

    async def fake_mode(user_id, session):
        # Pin the mode so the test is independent of any EE hook another test
        # may have registered (the community default is BYOK).
        return {"mode": "byok", "allowance": 0, "used": 0}

    monkeypatch.setattr(
        embedding_service, "get_user_llm_client_for_embedding", fake_get_client
    )
    monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", fake_mode)

    task = await _make_task(db_session, ai_user)

    await embedding_service.generate_and_store_embedding(
        db_session, task.id, ai_user, "Original title", "Original description"
    )
    assert len(client.calls) == 1

    # Same title + description: the stored source hash matches, so no provider call.
    await embedding_service.generate_and_store_embedding(
        db_session, task.id, ai_user, "Original title", "Original description"
    )
    assert len(client.calls) == 1

    stored = (
        await db_session.execute(
            TaskEmbedding.__table__.select().where(TaskEmbedding.task_id == task.id)
        )
    ).first()
    assert stored is not None
    assert stored.source_hash is not None

    # A real text change re-embeds once.
    await embedding_service.generate_and_store_embedding(
        db_session, task.id, ai_user, "Renamed title", "Original description"
    )
    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_no_ai_path_skips_embedding_entirely(db_session, ai_user, monkeypatch):
    """A user with no hosted entitlement and no key must not reach the provider."""
    from app.services import ai_entitlement

    client = _FakeClient()
    provider_calls = {"n": 0}

    async def fake_get_client(session, user_id):
        provider_calls["n"] += 1
        return ("openai", client)

    async def fake_mode(user_id, session):
        return {"mode": "none", "allowance": 0, "used": 0}

    monkeypatch.setattr(
        embedding_service, "get_user_llm_client_for_embedding", fake_get_client
    )
    monkeypatch.setattr(ai_entitlement, "_MODE_CHECK", fake_mode)

    task = await _make_task(db_session, ai_user)
    result = await embedding_service.generate_and_store_embedding(
        db_session, task.id, ai_user, "Original title", "Original description"
    )

    assert result is None
    assert client.calls == []
    assert provider_calls["n"] == 0
