import json
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_section import BoardSection
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services import timeline_organizer as mod


def test_normalize_topic():
    assert mod._normalize_topic("  video editing stuff ") == "Video Editing Stuff"
    assert mod._normalize_topic("work") == "Work"
    assert mod._normalize_topic("") == "Other"
    assert mod._normalize_topic(None) == "Other"
    assert mod._normalize_topic("A/B testing and more") == "A/B Testing And"


def test_parse_assignments_handles_fences_and_shapes():
    fenced = '```json\n[{"id": "t1", "topic": "Work"}, {"id": "t2", "topic": "Home"}]\n```'
    assert mod._parse_assignments(fenced) == {"t1": "Work", "t2": "Home"}
    wrapped = '{"assignments": [{"id": "t1", "topic": "Home"}]}'
    assert mod._parse_assignments(wrapped) == {"t1": "Home"}
    flat = '{"t1": "Work", "t2": "Errands"}'
    assert mod._parse_assignments(flat) == {"t1": "Work", "t2": "Errands"}
    assert mod._parse_assignments("not json") == {}


def test_parse_assignments_recovers_truncated_json():
    # max_tokens cut the final object off; the complete pairs must still parse.
    truncated = '[{"id": "t1", "topic": "Work"}, {"id": "t2", "topic": "Home"}, {"id": "t3", "topic": "Err'
    assert mod._parse_assignments(truncated) == {"t1": "Work", "t2": "Home"}


class _FakeClient:
    """Echoes one topic per task from a title->topic mapping."""

    def __init__(self, mapping):
        self.mapping = mapping
        self.closed = False

    async def chat(self, messages, tools=None, **kwargs):
        payload = messages[0]["content"].split("Tasks:\n", 1)[1]
        tasks = json.loads(payload)
        body = [
            {"id": t["id"], "topic": self.mapping.get(t["title"], "Other")}
            for t in tasks
        ]
        return {"choices": [{"message": {"content": json.dumps(body)}}]}

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_organize_timeline_creates_and_reuses_sections(db_session: AsyncSession, ai_user, monkeypatch):
    user = await db_session.get(User, ai_user)
    for title in ("Write report", "Fix bug", "Buy milk"):
        db_session.add(
            Task(
                user_id=ai_user,
                title=title,
                status=TaskStatus.TODO,
                start_date=date(2026, 9, 20),
            )
        )
    await db_session.flush()

    fake = _FakeClient({"Write report": "Work", "Fix bug": "Work", "Buy milk": "Errands"})

    async def fake_resolve(session, user_obj, provider, http_request=None):
        return ("prysmai", "fake-key", None)

    async def fake_build(provider, api_key, chain):
        return fake

    monkeypatch.setattr("app.routers.ai.resolve_llm_key", fake_resolve)
    monkeypatch.setattr("app.routers.ai._build_llm_client", fake_build)

    result = await mod.organize_timeline(db_session, user, force=True)
    assert result["skipped"] is False
    assert result["sections_created"] == 2
    assert result["tasks_assigned"] == 3
    assert set(result["topics"]) == {"Work", "Errands"}
    assert fake.closed is True

    sections = (
        await db_session.execute(
            select(BoardSection).where(
                BoardSection.user_id == ai_user, BoardSection.kind == "timeline"
            )
        )
    ).scalars().all()
    by_title = {s.title: s for s in sections}
    assert set(by_title) == {"Work", "Errands"}
    assert by_title["Work"].status is None

    write = (
        await db_session.execute(select(Task).where(Task.title == "Write report"))
    ).scalar_one()
    buy = (
        await db_session.execute(select(Task).where(Task.title == "Buy milk"))
    ).scalar_one()
    assert write.board_section_id == by_title["Work"].id
    assert buy.board_section_id == by_title["Errands"].id


@pytest.mark.asyncio
async def test_organize_timeline_skips_without_tasks(db_session: AsyncSession, ai_user):
    user = await db_session.get(User, ai_user)
    result = await mod.organize_timeline(db_session, user, force=True)
    assert result == {
        "sections_created": 0,
        "tasks_assigned": 0,
        "topics": [],
        "skipped": True,
        "remaining": 0,
    }


@pytest.mark.asyncio
async def test_organize_timeline_reports_remaining_over_budget(
    db_session: AsyncSession, ai_user, monkeypatch
):
    """F8: a run capped by MAX_TASKS must report the leftover count instead of
    implying the whole timeline was sorted."""
    user = await db_session.get(User, ai_user)
    for i in range(5):
        db_session.add(
            Task(
                user_id=ai_user,
                title=f"T{i}",
                status=TaskStatus.TODO,
                start_date=date(2026, 9, 20),
            )
        )
    await db_session.flush()
    monkeypatch.setattr(mod, "MAX_TASKS", 3)

    fake = _FakeClient({f"T{i}": "Work" for i in range(5)})

    async def fake_resolve(session, user_obj, provider, http_request=None):
        return ("prysmai", "k", None)

    async def fake_build(provider, api_key, chain):
        return fake

    monkeypatch.setattr("app.routers.ai.resolve_llm_key", fake_resolve)
    monkeypatch.setattr("app.routers.ai._build_llm_client", fake_build)

    result = await mod.organize_timeline(db_session, user, force=True)
    assert result["tasks_assigned"] == 3
    assert result["remaining"] == 2

    leftovers = (
        await db_session.execute(select(Task).where(Task.board_section_id.is_(None)))
    ).scalars().all()
    assert len(leftovers) == 2


class _FailingClient:
    async def chat(self, messages, tools=None, **kwargs):
        raise RuntimeError("provider down")

    async def aclose(self):
        pass


class _FlakyClient:
    """Raises for the first `fails` calls, then returns `then_content`."""

    def __init__(self, fails: int, then_content: str):
        self.fails = fails
        self.then_content = then_content
        self.calls = 0

    async def chat(self, messages, tools=None, **kwargs):
        self.calls += 1
        if self.calls <= self.fails:
            raise RuntimeError("429 rate limited")
        return {"choices": [{"message": {"content": self.then_content}}]}

    async def aclose(self):
        pass


@pytest.mark.asyncio
async def test_organize_timeline_raises_when_provider_fails(db_session: AsyncSession, ai_user, monkeypatch):
    """A total provider failure must surface, never masquerade as 'nothing to do'."""
    user = await db_session.get(User, ai_user)
    db_session.add(
        Task(user_id=ai_user, title="X", status=TaskStatus.TODO, start_date=date(2026, 9, 20))
    )
    await db_session.flush()

    async def fake_resolve(session, user_obj, provider, http_request=None):
        return ("prysmai", "k", None)

    async def fake_build(provider, api_key, chain):
        return _FailingClient()

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr("app.routers.ai.resolve_llm_key", fake_resolve)
    monkeypatch.setattr("app.routers.ai._build_llm_client", fake_build)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    with pytest.raises(RuntimeError):
        await mod.organize_timeline(db_session, user, force=True)


@pytest.mark.asyncio
async def test_organize_timeline_raises_on_empty_provider_content(db_session: AsyncSession, ai_user, monkeypatch):
    """An error/empty body (e.g. a reasoning cut-off) is a failure, not a skip."""
    user = await db_session.get(User, ai_user)
    db_session.add(
        Task(user_id=ai_user, title="X", status=TaskStatus.TODO, start_date=date(2026, 9, 20))
    )
    await db_session.flush()

    class _EmptyClient:
        async def chat(self, messages, tools=None, **kwargs):
            return {"choices": [{"message": {"content": ""}}]}

        async def aclose(self):
            pass

    async def fake_resolve(session, user_obj, provider, http_request=None):
        return ("prysmai", "k", None)

    async def fake_build(provider, api_key, chain):
        return _EmptyClient()

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr("app.routers.ai.resolve_llm_key", fake_resolve)
    monkeypatch.setattr("app.routers.ai._build_llm_client", fake_build)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    with pytest.raises(RuntimeError):
        await mod.organize_timeline(db_session, user, force=True)


@pytest.mark.asyncio
async def test_organize_timeline_retries_transient_failures(db_session: AsyncSession, ai_user, monkeypatch):
    user = await db_session.get(User, ai_user)
    task = Task(user_id=ai_user, title="T", status=TaskStatus.TODO, start_date=date(2026, 9, 20))
    db_session.add(task)
    await db_session.flush()

    flaky = _FlakyClient(fails=2, then_content=json.dumps([{"id": str(task.id), "topic": "Work"}]))

    async def fake_resolve(session, user_obj, provider, http_request=None):
        return ("prysmai", "k", None)

    async def fake_build(provider, api_key, chain):
        return flaky

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr("app.routers.ai.resolve_llm_key", fake_resolve)
    monkeypatch.setattr("app.routers.ai._build_llm_client", fake_build)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    result = await mod.organize_timeline(db_session, user, force=True)
    assert result["tasks_assigned"] == 1
    assert flaky.calls == 3
