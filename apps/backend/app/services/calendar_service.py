import asyncio
import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Sequence
from uuid import UUID

import httpx

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.calendar_event import CalendarEvent
from app.models.task import Task
from app.models.user_token import UserToken
from app.models.user_preference import UserPreference

logger = logging.getLogger(__name__)

# Google returns the granted scope set in its own normalized order, and with
# `include_granted_scopes=true` it returns the UNION of every scope the account
# already granted. oauthlib compares that against the requested list and raises
# a plain `Warning` exception when they differ, which surfaced as an opaque 500
# on the OAuth callback. Relaxing the token-scope check treats the returned set
# as authoritative instead of failing the connect. This must be set before the
# token exchange runs.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

# Prefix distinguishing Fernet-encrypted tokens at rest from legacy plaintext
# rows (which the startup backfill converts). Encryption uses the same
# ENCRYPTION_KEY as the API keys (app.utils.encryption).
_ENC_PREFIX = "enc:"

# The scopes the integration needs. `calendar.events` covers reading and writing
# events on every calendar the user can access; `calendar.calendarlist.readonly`
# is what `calendarList.list` requires, and it is NOT implied by
# `calendar.events` (listing the calendars themselves raises 403
# insufficientPermissions without it). A connection granted only the old
# `calendar.events` scope must be reconnected once to pick this up.
GOOGLE_CALENDAR_SCOPES = (
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
)

# Google returns at most 250 events per page; a couple of pages is plenty for a
# manual import and keeps a single request bounded on the small production box.
_GOOGLE_PAGE_SIZE = 250
_MAX_EVENT_PAGES = 2

# How far back an import looks. Google filters by the event's END time, so a
# start of "now" silently drops every event that already started today (and
# every all-day event, whose end is tomorrow only if it is today's). A lookback
# window makes "I created it in Google Calendar and pressed import" actually
# import it.
_IMPORT_LOOKBACK_DAYS = 30

# Upper bound on Google API calls per manual sync so the request can never run
# for minutes on the single-worker production box. Anything beyond the cap is
# reported as `remaining` and picked up by the next sync (or the background
# pull loop).
_MAX_SYNC_TASKS = 100
_SYNC_CONCURRENCY = 5

# A user's calendar list is tiny; cap it so a pathological account cannot turn
# the calendar-list call into an unbounded scan.
_MAX_CALENDARS = 50

# User preference keys (the value is a JSON object). Read by the core background
# pull loop; written by the EE calendar settings endpoint, so the community
# build simply never sees a value and keeps the global default interval.
CAL_SYNC_INTERVAL_KEY = "calendar_sync_interval_minutes"
CAL_SELECTED_IDS_KEY = "calendar_selected_calendars"

# Allowed auto-pull intervals, in minutes. The floor is enforced here (not only
# in the UI) so no stored value can make the server hammer Google per user.
CAL_INTERVAL_CHOICES = (15, 30, 60, 180, 360, 720, 1440)
CAL_INTERVAL_FLOOR = CAL_INTERVAL_CHOICES[0]
CAL_INTERVAL_MAX = CAL_INTERVAL_CHOICES[-1]


def _encrypt_token(value: str) -> str:
    if not value:
        return value
    from app.utils.encryption import get_cipher

    return _ENC_PREFIX + get_cipher().encrypt(value.encode()).decode()


def _decrypt_token(value: str) -> str:
    if not value:
        return value
    if value.startswith(_ENC_PREFIX):
        try:
            from app.utils.encryption import get_cipher

            return get_cipher().decrypt(value[len(_ENC_PREFIX):].encode()).decode()
        except Exception:
            return value
    return value


def get_google_oauth_flow(
    redirect_uri: str, extra_scopes: Sequence[str] = ()
) -> Flow:
    """Build the Google OAuth flow.

    ``extra_scopes`` lets a caller request additional scopes (for example the
    Gmail read scope) in the SAME consent so one Connect can grant both the
    calendar and the mailbox.
    """
    scopes: list[str] = list(GOOGLE_CALENDAR_SCOPES)
    for scope in extra_scopes:
        if scope not in scopes:
            scopes.append(scope)
    return Flow.from_client_config(
        {
            "web": {
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=scopes,
        redirect_uri=redirect_uri,
        autogenerate_code_verifier=False,
    )


async def store_tokens(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str | None,
    expiry: datetime | None,
) -> None:
    result = await session.execute(
        select(UserToken).where(
            UserToken.user_id == user_id,
            UserToken.provider == "google_calendar",
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.access_token = _encrypt_token(access_token)
        existing.refresh_token = _encrypt_token(refresh_token) if refresh_token else existing.refresh_token
        existing.expiry = expiry
    else:
        token = UserToken(
            user_id=user_id,
            provider="google_calendar",
            access_token=_encrypt_token(access_token),
            refresh_token=_encrypt_token(refresh_token) if refresh_token else None,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=" ".join(GOOGLE_CALENDAR_SCOPES),
            expiry=expiry,
        )
        session.add(token)
    await session.flush()


async def get_stored_tokens(session: AsyncSession, user_id: UUID) -> tuple[str, str] | None:
    result = await session.execute(
        select(UserToken).where(
            UserToken.user_id == user_id,
            UserToken.provider == "google_calendar",
        )
    )
    token = result.scalar_one_or_none()
    if token and token.access_token:
        return _decrypt_token(token.access_token), _decrypt_token(token.refresh_token or "")
    return None


async def revoke_google_token(token: str) -> bool:
    """Revoke a Google OAuth grant (best-effort).

    Disconnect used to only delete the local row, so Google kept the grant and
    the next Connect auto-approved the same account with no consent screen -
    a user could not even switch accounts. Revoking makes the next Connect a
    genuinely fresh authorization.
    """
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/revoke",
                data={"token": token},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        # 200 = revoked; 400 = already invalid/expired. Either way, it is gone.
        return resp.status_code in (200, 400)
    except httpx.HTTPError:
        return False


async def _get_pref(session: AsyncSession, user_id: UUID, key: str) -> dict | None:
    """The JSON value of a single user preference, or None."""
    result = await session.execute(
        select(UserPreference.value).where(
            UserPreference.user_id == user_id,
            UserPreference.key == key,
        )
    )
    return result.scalar_one_or_none()


def _clamp_interval(minutes: object) -> int:
    """Coerce a stored interval to an allowed range, defaulting to the global."""
    try:
        value = int(minutes)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return settings.gcal_pull_interval
    if value < CAL_INTERVAL_FLOOR:
        return CAL_INTERVAL_FLOOR
    return min(value, CAL_INTERVAL_MAX)


async def get_user_calendar_interval(session: AsyncSession, user_id: UUID) -> int:
    """The user's chosen auto-pull interval in minutes (defaults to the global).

    A stored value is always clamped to ``[CAL_INTERVAL_FLOOR, CAL_INTERVAL_MAX]``
    so a bad row can never make the background loop poll Google every minute."""
    value = await _get_pref(session, user_id, CAL_SYNC_INTERVAL_KEY)
    if not value:
        return settings.gcal_pull_interval
    return _clamp_interval(value.get("minutes"))


async def get_user_calendar_ids(session: AsyncSession, user_id: UUID) -> list[str] | None:
    """The calendars the user chose to sync, or None for "the primary one".

    Values are validated as non-empty strings and capped, so a tampered
    preference cannot fan one import out over hundreds of calendars."""
    value = await _get_pref(session, user_id, CAL_SELECTED_IDS_KEY)
    if not value:
        return None
    raw = value.get("ids")
    if not isinstance(raw, list):
        return None
    ids = [item for item in raw if isinstance(item, str) and item.strip()][:_MAX_CALENDARS]
    return ids or None


async def set_user_calendar_prefs(
    session: AsyncSession,
    user_id: UUID,
    interval_minutes: int | None = None,
    calendar_ids: list[str] | None = None,
) -> None:
    """Upsert the two calendar preferences (only the keys actually provided)."""
    updates: dict[str, dict] = {}
    if interval_minutes is not None:
        updates[CAL_SYNC_INTERVAL_KEY] = {"minutes": _clamp_interval(interval_minutes)}
    if calendar_ids is not None:
        ids = [item for item in calendar_ids if isinstance(item, str) and item.strip()][:_MAX_CALENDARS]
        updates[CAL_SELECTED_IDS_KEY] = {"ids": ids}
    for key, value in updates.items():
        result = await session.execute(
            select(UserPreference).where(
                UserPreference.user_id == user_id,
                UserPreference.key == key,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            session.add(UserPreference(user_id=user_id, key=key, value=value))
        else:
            row.value = value
    await session.flush()


def get_google_calendar_service(access_token: str, refresh_token: str):
    creds = Credentials(
        token=access_token,
        refresh_token=refresh_token or None,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return build("calendar", "v3", credentials=creds)


def _maybe_refreshed(service, access_token: str, refresh_token: str) -> tuple[str, str, datetime] | None:
    """Return ``(access_token, refresh_token, expiry)`` when the credentials were
    refreshed during the blocking call, else None (token unchanged). The
    googleapiclient http layer mutates its credentials object in place when the
    access token expired, so comparing the post-call token to the input reveals
    the refresh side effect without an extra network round-trip."""
    creds = getattr(service._http, "credentials", None)
    if creds and creds.token != access_token:
        return (creds.token, creds.refresh_token or refresh_token, creds.expiry)
    return None


def _list_events_blocking(
    access_token: str,
    refresh_token: str,
    max_results: int = 50,
    time_min: str | None = None,
    calendar_id: str = "primary",
) -> tuple[list[dict], tuple[str, str, datetime] | None]:
    """Synchronous Google calendar events().list() - call via asyncio.to_thread.

    ``time_min`` is an RFC3339 timestamp; it defaults to the current time (the
    "what is coming up" view). Imports pass a lookback window instead so events
    that already started today are not filtered out.

    Pages through the results with a bounded loop (``_MAX_EVENT_PAGES``) so a
    long calendar cannot turn one request into an unbounded scan.

    Returns ``(items, refreshed_tokens_or_None)`` so the caller can persist a
    token refresh side effect without re-fetching credentials."""
    service = get_google_calendar_service(access_token, refresh_token)
    refreshed = _maybe_refreshed(service, access_token, refresh_token)
    lower_bound = time_min or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    items: list[dict] = []
    page_token: str | None = None
    for _ in range(_MAX_EVENT_PAGES):
        remaining = max_results - len(items)
        if remaining <= 0:
            break
        events_result = service.events().list(
            calendarId=calendar_id,
            timeMin=lower_bound,
            maxResults=min(_GOOGLE_PAGE_SIZE, remaining),
            singleEvents=True,
            orderBy="startTime",
            pageToken=page_token,
        ).execute()
        items.extend(events_result.get("items", []))
        page_token = events_result.get("nextPageToken")
        if not page_token:
            break
    return items, refreshed


def _upsert_event_blocking(
    access_token: str,
    refresh_token: str,
    event_body: dict,
    google_event_id: str | None = None,
    calendar_id: str = "primary",
) -> tuple[str, str, tuple[str, str, datetime] | None]:
    """Synchronous insert-or-update of a calendar event - call via to_thread.

    Returns ``(google_event_id, html_link, refreshed_tokens_or_None)``."""
    service = get_google_calendar_service(access_token, refresh_token)
    refreshed = _maybe_refreshed(service, access_token, refresh_token)
    if google_event_id:
        result = service.events().update(
            calendarId=calendar_id,
            eventId=google_event_id,
            body=event_body,
        ).execute()
    else:
        result = service.events().insert(calendarId=calendar_id, body=event_body).execute()
    return result["id"], result.get("htmlLink", ""), refreshed


def list_calendars_blocking(
    access_token: str,
    refresh_token: str,
) -> tuple[list[dict], tuple[str, str, datetime] | None]:
    """The user's Google calendar list (id, name, access role, primary flag).

    Call via ``asyncio.to_thread``. Only calendars the user can write to are
    returned, because those are the only ones sync can push tasks into.
    """
    service = get_google_calendar_service(access_token, refresh_token)
    refreshed = _maybe_refreshed(service, access_token, refresh_token)
    result = service.calendarList().list(maxResults=_MAX_CALENDARS, minAccessRole="writer").execute()
    calendars = [
        {
            "id": item.get("id"),
            "name": item.get("summaryOverride") or item.get("summary") or item.get("id"),
            "primary": bool(item.get("primary")),
        }
        for item in result.get("items", [])
        if item.get("id")
    ]
    return calendars, refreshed


async def list_calendars(access_token: str, refresh_token: str) -> list[dict]:
    """Async wrapper: list the writable calendars for the connect UI."""
    try:
        calendars, _ = await asyncio.to_thread(list_calendars_blocking, access_token, refresh_token)
        return calendars
    except Exception as exc:  # noqa: BLE001 - surface a short reason to the caller
        logger.warning("calendar list failed: %s", exc)
        raise


def _parse_iso_date(raw: str | None) -> date | None:
    """Google dates are ISO strings ("2026-09-23" or "2026-09-23T10:00:00+02:00").

    The columns are SQL ``date``, so a raw string raises on insert (asyncpg:
    ``'str' object has no attribute 'toordinal'``). Always convert, and treat an
    unparseable value as absent rather than failing the whole import."""
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _google_event_date(info: dict | None) -> date | None:
    """The start/end date of a Google Calendar event, as a ``date``."""
    if not info:
        return None
    return _parse_iso_date(info.get("date") or info.get("dateTime"))


def _google_error_reason(exc: BaseException) -> str:
    """A short, actionable reason for a failed Google Calendar call.

    Google's raw message is a wall of JSON ("HttpError 403 ... it is disabled.
    Enable it by visiting https://console.developers.google.com/...") which is
    useless in a toast. Map the cases a user or admin can actually act on, and
    fall back to a trimmed form of the original.
    """
    text = str(exc)
    lowered = text.lower()
    if "accessnotconfigured" in lowered or "has not been used in project" in lowered or (
        "disabled" in lowered and "console.developers.google.com" in lowered
    ):
        return (
            "The Google Calendar API is not enabled for this server's Google Cloud "
            "project. An administrator must enable it, then try again."
        )
    if "insufficient" in lowered or "insufficientpermissions" in lowered:
        # The token was granted before the calendar-list scope was requested (or
        # the user denied it): Google answers with a plain 403 whose message is
        # only readable in the raw body. Reconnecting re-prompts for consent.
        return (
            "The saved Google connection is missing calendar permissions. "
            "Reconnect Google Calendar to grant access, then try again."
        )
    if "invalid_grant" in lowered or "invalid credentials" in lowered:
        return "Google rejected the saved credentials. Reconnect Google Calendar and try again."
    status = getattr(getattr(exc, "resp", None), "status", None)
    if status == 401:
        return "Google rejected the saved credentials. Reconnect Google Calendar and try again."
    if status == 403:
        return "Google denied the request. Reconnect Google Calendar and check its permissions."
    if status == 429 or "ratelimitexceeded" in lowered or "quota" in lowered:
        return "Google rate limited the request. Try again in a few minutes."
    if "timed out" in lowered or "timeout" in lowered:
        return "Google did not respond in time. Try again."
    return text[:200]


def _task_event_body(task: Task) -> dict:
    """The Google Calendar event body representing a task."""
    return {
        "summary": task.title,
        "description": task.description or "",
        "start": {"date": str(task.start_date), "timeZone": "UTC"},
        "end": {"date": str(task.due_date or task.start_date), "timeZone": "UTC"},
    }


async def push_task_to_calendar(
    session: AsyncSession,
    user_id: UUID,
    task: Task,
    access_token: str,
    refresh_token: str,
) -> dict | None:
    try:
        event_body = _task_event_body(task)
        google_event_id, html_link, refreshed = await asyncio.to_thread(
            _upsert_event_blocking, access_token, refresh_token, event_body
        )
        if refreshed:
            new_access, new_refresh, expiry = refreshed
            await store_tokens(session, user_id, new_access, new_refresh, expiry)

        cal_event = CalendarEvent(
            user_id=user_id,
            task_id=task.id,
            google_event_id=google_event_id,
            calendar_id="primary",
            sync_action="push",
        )
        session.add(cal_event)
        await session.flush()
        return {"id": google_event_id, "htmlLink": html_link}
    except Exception as e:
        return None


async def pull_events_from_calendar(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
) -> list[dict]:
    try:
        items, refreshed = await asyncio.to_thread(_list_events_blocking, access_token, refresh_token)
        if refreshed:
            new_access, new_refresh, expiry = refreshed
            await store_tokens(session, user_id, new_access, new_refresh, expiry)
        return items
    except Exception:
        return []


async def pull_and_import_events(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
    days_back: int = _IMPORT_LOOKBACK_DAYS,
    max_events: int = _GOOGLE_PAGE_SIZE,
    calendar_ids: list[str] | None = None,
) -> dict:
    """Import Google Calendar events as tasks.

    ``days_back`` widens the window behind "now" so events that already started
    (including today's) are imported rather than silently skipped.
    ``calendar_ids`` restricts the import to the user's chosen calendars; the
    default is their primary calendar alone."""
    calendars = calendar_ids or ["primary"]
    time_min = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    try:
        items: list[tuple[dict, str]] = []
        for cal_id in calendars:
            # One (bounded) list call per selected calendar, sequential so a
            # multi-calendar import cannot fan out into a request storm.
            cal_items, refreshed = await asyncio.to_thread(
                _list_events_blocking,
                access_token,
                refresh_token,
                max_events,
                time_min,
                cal_id,
            )
            items.extend((item, cal_id) for item in cal_items)
            if refreshed:
                new_access, new_refresh, expiry = refreshed
                await store_tokens(
                    session,
                    user_id,
                    new_access,
                    new_refresh,
                    expiry,
                )

        imported = 0
        for item, cal_id in items:
            google_event_id = item.get("id")
            # Scoped by calendar: an event id is only unique within its calendar.
            existing = await session.execute(
                select(CalendarEvent).where(
                    CalendarEvent.user_id == user_id,
                    CalendarEvent.google_event_id == google_event_id,
                    CalendarEvent.calendar_id == cal_id,
                )
            )
            if existing.scalar_one_or_none():
                continue

            title = item.get("summary", "Untitled Event")
            start_date = _google_event_date(item.get("start"))
            due_date = _google_event_date(item.get("end"))

            task = Task(
                user_id=user_id,
                title=title,
                description=item.get("description", ""),
                start_date=start_date,
                due_date=due_date,
                status="todo",
            )
            session.add(task)
            await session.flush()

            cal_event = CalendarEvent(
                user_id=user_id,
                task_id=task.id,
                google_event_id=google_event_id,
                calendar_id=cal_id,
                sync_action="pull",
            )
            session.add(cal_event)
            imported += 1

        await session.commit()
        return {
            "imported": imported,
            "total_events": len(items),
            "window_days": days_back,
            "calendars": calendars,
        }
    except Exception as e:
        await session.rollback()
        # Surface the real reason in the logs: the API response carries `error`,
        # but a caller that only reads `imported` used to hide it entirely.
        logger.warning("calendar import failed for user %s: %s", user_id, e)
        return {"imported": 0, "error": _google_error_reason(e)}


async def sync_all_tasks(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
    calendar_id: str = "primary",
) -> dict:
    """Push pending tasks to Google Calendar.

    Bounded and incremental: only tasks that were never pushed (or changed since
    their last push) are considered, at most ``_MAX_SYNC_TASKS`` per call, and
    the Google round trips run with bounded concurrency. The previous version
    pushed EVERY task with a start date, one serial request each, which made a
    real account's sync run for minutes and time out at the edge.
    ``calendar_id`` is the destination calendar (the user's chosen one, or
    ``primary``); a task is pushed once, to one calendar."""
    pushed_match = (
        select(CalendarEvent.id)
        .where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.task_id == Task.id,
            CalendarEvent.sync_action == "push",
            CalendarEvent.last_synced_at >= Task.updated_at,
        )
        .exists()
    )
    pending_filter = (
        Task.user_id == user_id,
        Task.start_date.isnot(None),
        Task.deleted_at.is_(None),
        Task.status.notin_(["cancelled"]),
        ~pushed_match,
    )

    total_pending = await session.scalar(
        select(func.count()).select_from(Task).where(*pending_filter)
    ) or 0

    result = await session.execute(
        select(Task)
        .where(*pending_filter)
        .order_by(Task.updated_at.desc())
        .limit(_MAX_SYNC_TASKS)
    )
    tasks = result.scalars().all()

    existing_by_task: dict[str, CalendarEvent] = {}
    if tasks:
        existing_result = await session.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == user_id,
                CalendarEvent.task_id.in_([t.id for t in tasks]),
                CalendarEvent.sync_action == "push",
                CalendarEvent.calendar_id == calendar_id,
            )
        )
        existing_by_task = {
            ce.task_id: ce for ce in existing_result.scalars().all() if ce.task_id is not None
        }

    semaphore = asyncio.Semaphore(_SYNC_CONCURRENCY)

    async def _push_one(task: Task):
        async with semaphore:
            try:
                google_event_id, _html, refreshed = await asyncio.to_thread(
                    _upsert_event_blocking,
                    access_token,
                    refresh_token,
                    _task_event_body(task),
                    existing_by_task[task.id].google_event_id if task.id in existing_by_task else None,
                    calendar_id,
                )
                return task, google_event_id, refreshed, None
            except Exception as exc:  # noqa: BLE001 - one bad task must not abort the batch
                return task, None, None, exc

    outcomes = await asyncio.gather(*[_push_one(t) for t in tasks]) if tasks else []

    pushed = 0
    failed = 0
    service_refreshed = None
    first_error: str | None = None
    now = datetime.now(timezone.utc)
    for task, google_event_id, refreshed, exc in outcomes:
        if exc is not None:
            failed += 1
            if first_error is None:
                first_error = _google_error_reason(exc)
            logger.warning("calendar push failed for task %s: %s", task.id, exc)
            continue
        if refreshed:
            service_refreshed = refreshed
        existing_cal = existing_by_task.get(task.id)
        if existing_cal is not None:
            existing_cal.last_synced_at = now
        else:
            session.add(
                CalendarEvent(
                    user_id=user_id,
                    task_id=task.id,
                    google_event_id=google_event_id,
                    calendar_id=calendar_id,
                    sync_action="push",
                )
            )
        pushed += 1

    if service_refreshed:
        new_access, new_refresh, expiry = service_refreshed
        await store_tokens(session, user_id, new_access, new_refresh, expiry)

    await session.flush()
    return {
        "pushed": pushed,
        "failed": failed,
        "total": len(tasks),
        "remaining": max(0, total_pending - len(tasks)),
        "error": first_error,
    }


async def backfill_encrypted_tokens(session: AsyncSession) -> int:
    """Encrypt any legacy plaintext Google Calendar tokens left at rest.

    Idempotent and best-effort: rows whose access/refresh tokens already start
    with the ``enc:`` prefix are left untouched. Runs once at startup through the
    BYPASSRLS system engine so every user's tokens are covered.
    """
    result = await session.execute(
        select(UserToken).where(UserToken.provider == "google_calendar")
    )
    tokens = result.scalars().all()
    converted = 0
    for token in tokens:
        changed = False
        if token.access_token and not token.access_token.startswith(_ENC_PREFIX):
            token.access_token = _encrypt_token(token.access_token)
            changed = True
        if token.refresh_token and not token.refresh_token.startswith(_ENC_PREFIX):
            token.refresh_token = _encrypt_token(token.refresh_token)
            changed = True
        if changed:
            converted += 1
    if converted:
        await session.commit()
    return converted