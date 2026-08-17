from datetime import datetime, timezone
from uuid import UUID

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.calendar_event import CalendarEvent
from app.models.task import Task
from app.models.user_token import UserToken

# Prefix distinguishing Fernet-encrypted tokens at rest from legacy plaintext
# rows (which the startup backfill converts). Encryption uses the same
# ENCRYPTION_KEY as the API keys (app.utils.encryption).
_ENC_PREFIX = "enc:"


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


def get_google_oauth_flow(redirect_uri: str) -> Flow:
    return Flow.from_client_config(
        {
            "web": {
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        redirect_uri=redirect_uri,
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
            scopes="https://www.googleapis.com/auth/calendar.events",
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


async def push_task_to_calendar(
    session: AsyncSession,
    user_id: UUID,
    task: Task,
    access_token: str,
    refresh_token: str,
) -> dict | None:
    try:
        service = get_google_calendar_service(access_token, refresh_token)
        event_body = {
            "summary": task.title,
            "description": task.description or "",
            "start": {"date": str(task.start_date), "timeZone": "UTC"},
            "end": {"date": str(task.due_date or task.start_date), "timeZone": "UTC"},
        }
        created = service.events().insert(calendarId="primary", body=event_body).execute()

        cal_event = CalendarEvent(
            user_id=user_id,
            task_id=task.id,
            google_event_id=created["id"],
            calendar_id="primary",
            sync_action="push",
        )
        session.add(cal_event)
        await session.flush()
        return {"id": created["id"], "htmlLink": created.get("htmlLink", "")}
    except Exception as e:
        return None


async def pull_events_from_calendar(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
) -> list[dict]:
    try:
        service = get_google_calendar_service(access_token, refresh_token)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        events_result = service.events().list(
            calendarId="primary",
            timeMin=now,
            maxResults=50,
            singleEvents=True,
            orderBy="startTime",
        ).execute()
        return events_result.get("items", [])
    except Exception:
        return []


async def pull_and_import_events(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
) -> dict:
    try:
        service = get_google_calendar_service(access_token, refresh_token)
        creds = service._http.credentials

        if creds and creds.token != access_token:
            await store_tokens(
                session,
                user_id,
                creds.token,
                creds.refresh_token or refresh_token,
                creds.expiry,
            )

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        events_result = service.events().list(
            calendarId="primary",
            timeMin=now,
            maxResults=50,
            singleEvents=True,
            orderBy="startTime",
        ).execute()
        items = events_result.get("items", [])

        imported = 0
        for item in items:
            google_event_id = item.get("id")
            existing = await session.execute(
                select(CalendarEvent).where(
                    CalendarEvent.user_id == user_id,
                    CalendarEvent.google_event_id == google_event_id,
                )
            )
            if existing.scalar_one_or_none():
                continue

            title = item.get("summary", "Untitled Event")
            start_info = item.get("start", {})
            end_info = item.get("end", {})
            start_date = start_info.get("date") or (start_info.get("dateTime", "").split("T")[0] if start_info.get("dateTime") else None)
            due_date = end_info.get("date") or (end_info.get("dateTime", "").split("T")[0] if end_info.get("dateTime") else None)

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
                calendar_id="primary",
                sync_action="pull",
            )
            session.add(cal_event)
            imported += 1

        await session.commit()
        return {"imported": imported, "total_events": len(items)}
    except Exception as e:
        await session.rollback()
        return {"imported": 0, "error": str(e)}


async def sync_all_tasks(
    session: AsyncSession,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
) -> dict:
    pushed = 0
    failed = 0

    service = get_google_calendar_service(access_token, refresh_token)

    result = await session.execute(
        select(Task).where(
            Task.user_id == user_id,
            Task.start_date.isnot(None),
            Task.status.notin_(["cancelled"]),
        )
    )
    tasks = result.scalars().all()

    for task in tasks:
        existing_result = await session.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == user_id,
                CalendarEvent.task_id == task.id,
                CalendarEvent.sync_action == "push",
            )
        )
        existing_cal = existing_result.scalar_one_or_none()

        event_body = {
            "summary": task.title,
            "description": task.description or "",
            "start": {"date": str(task.start_date), "timeZone": "UTC"},
            "end": {"date": str(task.due_date or task.start_date), "timeZone": "UTC"},
        }

        try:
            if existing_cal:
                service.events().update(
                    calendarId="primary",
                    eventId=existing_cal.google_event_id,
                    body=event_body,
                ).execute()
            else:
                created = service.events().insert(calendarId="primary", body=event_body).execute()
                cal_event = CalendarEvent(
                    user_id=user_id,
                    task_id=task.id,
                    google_event_id=created["id"],
                    calendar_id="primary",
                    sync_action="push",
                )
                session.add(cal_event)
            pushed += 1
        except Exception:
            failed += 1

    await session.flush()
    return {"pushed": pushed, "failed": failed, "total": len(tasks)}


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