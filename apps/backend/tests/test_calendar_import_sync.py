"""Regression tests for the calendar import window and the bounded,
incremental task->calendar push.

Two production bugs are pinned here:
1. ``pull_and_import_events`` used to list with ``timeMin=now``, so every event
   that had already started (today's included, since Google filters on the
   event's END time) was silently skipped and "Import from calendar" imported
   nothing while still returning 200.
2. ``sync_all_tasks`` used to push every task with a start date, one serial
   Google request each, which made a real account's sync run for minutes and
   time out at the edge.
"""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.calendar_event import CalendarEvent
from app.models.task import Task
from app.services import calendar_service as cs


def _event(event_id: str, summary: str, day: date) -> dict:
    iso = day.isoformat()
    return {
        "id": event_id,
        "summary": summary,
        "description": "from google",
        "start": {"date": iso},
        "end": {"date": iso},
    }


async def test_import_uses_a_lookback_window_not_now(db_session, test_user, monkeypatch):
    """The list call must look BACK, otherwise events that already started are
    dropped by Google's end-time filter."""
    captured: dict[str, str | None] = {}

    def _stub_list(access_token, refresh_token, max_results=50, time_min=None, calendar_id="primary"):
        captured["time_min"] = time_min
        captured["calendar_id"] = calendar_id
        return [], None

    monkeypatch.setattr(cs, "_list_events_blocking", _stub_list)

    result = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh"
    )

    assert result["imported"] == 0
    assert "error" not in result
    # The primary calendar is the default destination.
    assert captured["calendar_id"] == "primary"
    time_min = captured["time_min"]
    assert time_min is not None
    parsed = datetime.strptime(time_min, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    # A 30 day lookback, comfortably behind "now" (the old behaviour).
    assert parsed < datetime.now(timezone.utc) - timedelta(days=20)


async def test_import_creates_tasks_and_dedupes(db_session, test_user, monkeypatch):
    today = datetime.now(timezone.utc).date()
    events = [_event("evt-1", "Standup", today), _event("evt-2", "Retro", today)]

    monkeypatch.setattr(
        cs, "_list_events_blocking", lambda *a, **k: (events, None)
    )

    first = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh"
    )
    assert first["imported"] == 2
    assert first["total_events"] == 2

    tasks = (
        await db_session.execute(
            select(Task).where(Task.user_id == test_user.id, Task.title == "Standup")
        )
    ).scalars().all()
    assert len(tasks) == 1
    assert tasks[0].start_date == today

    pulled = (
        await db_session.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == test_user.id,
                CalendarEvent.sync_action == "pull",
            )
        )
    ).scalars().all()
    assert len(pulled) == 2

    # Second import is idempotent: same google_event_id is skipped, not duplicated.
    second = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh"
    )
    assert second["imported"] == 0


async def test_import_surfaces_a_google_failure(db_session, test_user, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("Google said no")

    monkeypatch.setattr(cs, "_list_events_blocking", _boom)

    result = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh"
    )
    assert result["imported"] == 0
    assert "Google said no" in result["error"]


async def test_sync_pushes_pending_tasks_and_is_incremental(db_session, test_user, monkeypatch):
    created = []

    def _stub_upsert(access_token, refresh_token, event_body, google_event_id=None, calendar_id="primary"):
        created.append((event_body["summary"], google_event_id, calendar_id))
        return f"evt-{len(created)}", "http://calendar/evt", None

    monkeypatch.setattr(cs, "_upsert_event_blocking", _stub_upsert)

    task = Task(user_id=test_user.id, title="Write report", start_date=date(2026, 9, 20))
    db_session.add(task)
    await db_session.commit()

    first = await cs.sync_all_tasks(db_session, test_user.id, "fake-access", "fake-refresh")
    assert first["pushed"] == 1
    assert first["failed"] == 0
    assert first["total"] == 1
    assert first["remaining"] == 0
    assert created[0] == ("Write report", None, "primary")

    pushed_rows = (
        await db_session.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == test_user.id,
                CalendarEvent.sync_action == "push",
            )
        )
    ).scalars().all()
    assert len(pushed_rows) == 1

    # Nothing changed, so the second sync must not call Google again.
    second = await cs.sync_all_tasks(db_session, test_user.id, "fake-access", "fake-refresh")
    assert second["pushed"] == 0
    assert second["total"] == 0
    assert len(created) == 1


async def test_sync_is_bounded_by_max_sync_tasks(db_session, test_user, monkeypatch):
    monkeypatch.setattr(cs, "_MAX_SYNC_TASKS", 2)
    monkeypatch.setattr(
        cs,
        "_upsert_event_blocking",
        lambda access_token, refresh_token, event_body, google_event_id=None, calendar_id="primary": (
            "evt-x",
            "http://calendar/x",
            None,
        ),
    )

    for i in range(3):
        db_session.add(
            Task(user_id=test_user.id, title=f"Task {i}", start_date=date(2026, 9, 20))
        )
    await db_session.commit()

    result = await cs.sync_all_tasks(db_session, test_user.id, "fake-access", "fake-refresh")
    assert result["total"] == 2
    assert result["pushed"] == 2
    assert result["remaining"] == 1


@pytest.mark.parametrize("status", ["cancelled"])
async def test_sync_skips_cancelled_tasks(db_session, test_user, monkeypatch, status):
    calls = []
    monkeypatch.setattr(
        cs,
        "_upsert_event_blocking",
        lambda access_token, refresh_token, event_body, google_event_id=None, calendar_id="primary": (
            calls.append(event_body["summary"]) or ("evt-c", "", None)
        ),
    )

    db_session.add(
        Task(
            user_id=test_user.id,
            title="Dropped",
            start_date=date(2026, 9, 20),
            status=status,
        )
    )
    await db_session.commit()

    result = await cs.sync_all_tasks(db_session, test_user.id, "fake-access", "fake-refresh")
    assert result["pushed"] == 0
    assert calls == []


def test_google_error_reason_explains_a_disabled_api():
    """The raw 403 that broke production was a wall of JSON; the user must get a
    sentence they can act on (enable the API / reconnect), not the raw payload."""
    raw = (
        "<HttpError 403 when requesting https://www.googleapis.com/calendar/v3/calendars/"
        "primary/events returned \"Google Calendar API has not been used in project "
        "157292279473 before or it is disabled. Enable it by visiting "
        "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/"
        "overview?project=157292279473 then retry.\". Details: \"[{'reason': "
        "'accessNotConfigured'}]\">"
    )
    reason = cs._google_error_reason(RuntimeError(raw))
    assert "Calendar API is not enabled" in reason
    assert "administrator" in reason
    # The raw JSON must not leak into the user-facing string.
    assert "console.developers.google.com" not in reason


def test_google_error_reason_maps_auth_and_quota():
    assert "Reconnect" in cs._google_error_reason(RuntimeError("invalid_grant"))
    assert "rate limited" in cs._google_error_reason(RuntimeError("rateLimitExceeded"))
    # An unknown failure still returns something short and non-empty.
    assert cs._google_error_reason(RuntimeError("something odd")) == "something odd"


def test_google_error_reason_explains_insufficient_scopes():
    """A token granted before the calendar-list scope existed answers 403 with
    "insufficient authentication scopes"; the fix is a reconnect, and the user
    must be told so rather than seeing the raw Google payload."""
    raw = (
        "<HttpError 403 when requesting https://www.googleapis.com/calendar/v3/users/me/"
        "calendarList?maxResults=50&minAccessRole=writer&alt=json returned \"Request had "
        "insufficient authentication scopes.\". Details: \"[{'message': 'Insufficient "
        "Permission', 'domain': 'global', 'reason': 'insufficientPermissions'}]\">"
    )
    reason = cs._google_error_reason(RuntimeError(raw))
    assert "missing calendar permissions" in reason
    assert "Reconnect" in reason
    # The raw Google payload must not leak into the user-facing string.
    assert "insufficientPermissions" not in reason


def test_calendar_scopes_cover_listing_calendars():
    """`calendarList.list` is NOT covered by `calendar.events`: without the
    calendar-list scope every calendars call 403s (the production symptom), so
    the requested scopes must include it and the stored scopes must record it."""
    assert "https://www.googleapis.com/auth/calendar.events" in cs.GOOGLE_CALENDAR_SCOPES
    assert (
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
        in cs.GOOGLE_CALENDAR_SCOPES
    )


async def test_sync_reports_the_first_push_failure(db_session, test_user, monkeypatch):
    """A sync where every push fails must carry the reason, otherwise the UI can
    only say "N could not be pushed" and the cause stays invisible."""

    def _boom(*a, **k):
        raise RuntimeError("invalid_grant")

    monkeypatch.setattr(cs, "_upsert_event_blocking", _boom)

    db_session.add(Task(user_id=test_user.id, title="A", start_date=date(2026, 9, 20)))
    await db_session.commit()

    result = await cs.sync_all_tasks(db_session, test_user.id, "fake-access", "fake-refresh")
    assert result["pushed"] == 0
    assert result["failed"] == 1
    assert "Reconnect Google Calendar" in result["error"]


async def test_revoke_google_token_posts_to_the_revoke_endpoint(monkeypatch):
    """Disconnect must revoke the grant, or Google silently re-approves the same
    account on the next Connect and the user can never switch accounts."""
    seen: dict[str, object] = {}

    class _Resp:
        status_code = 200

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None, headers=None):
            seen["url"] = url
            seen["data"] = data
            return _Resp()

    monkeypatch.setattr(cs.httpx, "AsyncClient", _Client)

    assert await cs.revoke_google_token("refresh-token-abc") is True
    assert seen["url"] == "https://oauth2.googleapis.com/revoke"
    assert seen["data"] == {"token": "refresh-token-abc"}


async def test_revoke_google_token_is_best_effort(monkeypatch):
    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None, headers=None):
            raise cs.httpx.ConnectError("no network")

    monkeypatch.setattr(cs.httpx, "AsyncClient", _Client)
    # Never raises, and an empty token short-circuits.
    assert await cs.revoke_google_token("tok") is False
    assert await cs.revoke_google_token("") is False


async def test_calendar_interval_pref_defaults_and_clamps(db_session, test_user):
    """The per-user auto-pull interval must be bounded server-side, so no stored
    value can make the shared background loop poll Google per minute."""
    from app.config import settings

    # No preference yet -> the global default.
    assert await cs.get_user_calendar_interval(db_session, test_user.id) == settings.gcal_pull_interval

    # Below the floor is raised to it (a 1-minute value must not survive).
    await cs.set_user_calendar_prefs(db_session, test_user.id, interval_minutes=1)
    assert await cs.get_user_calendar_interval(db_session, test_user.id) == cs.CAL_INTERVAL_FLOOR

    # Absurdly high is capped, not stored raw.
    await cs.set_user_calendar_prefs(db_session, test_user.id, interval_minutes=999_999)
    assert await cs.get_user_calendar_interval(db_session, test_user.id) == cs.CAL_INTERVAL_MAX

    # A normal choice round-trips.
    await cs.set_user_calendar_prefs(db_session, test_user.id, interval_minutes=60)
    assert await cs.get_user_calendar_interval(db_session, test_user.id) == 60


async def test_calendar_selection_pref_is_validated(db_session, test_user):
    await cs.set_user_calendar_prefs(db_session, test_user.id, calendar_ids=["work", "", "home"])
    assert await cs.get_user_calendar_ids(db_session, test_user.id) == ["work", "home"]

    # An empty selection means "no explicit choice" -> the primary calendar.
    await cs.set_user_calendar_prefs(db_session, test_user.id, calendar_ids=[])
    assert await cs.get_user_calendar_ids(db_session, test_user.id) is None


async def test_multi_calendar_import_reads_every_selected_calendar(db_session, test_user, monkeypatch):
    """Events from each selected calendar are imported (and de-duped per
    calendar, since a Google event id is only unique within one)."""
    today = datetime.now(timezone.utc).date()
    per_calendar = {
        "work": [_event("work-1", "Standup", today)],
        "home": [_event("home-1", "Groceries", today)],
    }
    seen: list[str] = []

    def _stub_list(access_token, refresh_token, max_results=50, time_min=None, calendar_id="primary"):
        seen.append(calendar_id)
        return per_calendar.get(calendar_id, []), None

    monkeypatch.setattr(cs, "_list_events_blocking", _stub_list)

    result = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh", calendar_ids=["work", "home"]
    )
    assert seen == ["work", "home"]
    assert result["imported"] == 2
    assert result["calendars"] == ["work", "home"]

    titles = (
        await db_session.execute(select(Task.title).where(Task.user_id == test_user.id))
    ).scalars().all()
    assert sorted(titles) == ["Groceries", "Standup"]

    # Re-import is idempotent across both calendars.
    again = await cs.pull_and_import_events(
        db_session, test_user.id, "fake-access", "fake-refresh", calendar_ids=["work", "home"]
    )
    assert again["imported"] == 0


async def test_sync_pushes_to_the_chosen_calendar(db_session, test_user, monkeypatch):
    created: list[tuple[str, str]] = []

    def _stub_upsert(access_token, refresh_token, event_body, google_event_id=None, calendar_id="primary"):
        created.append((event_body["summary"], calendar_id))
        return "evt-1", "", None

    monkeypatch.setattr(cs, "_upsert_event_blocking", _stub_upsert)

    db_session.add(Task(user_id=test_user.id, title="Deploy", start_date=date(2026, 9, 20)))
    await db_session.commit()

    result = await cs.sync_all_tasks(
        db_session, test_user.id, "fake-access", "fake-refresh", calendar_id="team-cal"
    )
    assert result["pushed"] == 1
    assert created == [("Deploy", "team-cal")]

    rows = (
        await db_session.execute(
            select(CalendarEvent.calendar_id).where(
                CalendarEvent.user_id == test_user.id,
                CalendarEvent.sync_action == "push",
            )
        )
    ).scalars().all()
    assert rows == ["team-cal"]
