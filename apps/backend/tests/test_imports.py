import pytest
from datetime import date
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note import Note
from app.models.tag import Tag
from app.models.task import Task
from app.models.task_tag import TaskTag


TICKTICK_HEADER = (
    "Folder Name,List Name,Title,Tags,Content,Is Check list,Start Date,Due Date,"
    "Reminder,Repeat,Priority,Status,Created Time,Completed Time,Order,Timezone,"
    "Is All Day,Is Floating,Column Name,Column Order,View Mode,taskId,parentId"
)


def build_ticktick_rows() -> bytes:
    return (
        "Date: 2022-03-01\nVersion: 1\n\n"
        + TICKTICK_HEADER
        + "\n"
        + 'Work,Work,Hire contractor,"web,work","Prepare a brief",N,'
        "2022-03-14 19:31:02+0000,2022-03-15,09:00,FREQ=WEEKLY;BYDAY=MO,5,0,"
        "2022-03-01 10:00:00+0000,,1,Europe/Berlin,0,0,List,0,1,tt-task-1,\n"
        + "Work,Work,Pay invoice,,,N,2022-03-14,,,,3,1,"
        "2022-03-01 10:00:00+0000,2022-03-15 08:00:00+0000,2,Europe/Berlin,"
        "0,0,List,1,1,tt-task-2,tt-task-1\n"
    ).encode("utf-8")


def build_ticktick_checklist() -> bytes:
    return (
        TICKTICK_HEADER
        + "\n"
        + 'Work,Work,Launch checklist,,"▫ Prep assets\n▪ Send to review\n[x] Publish",'
        "Y,2022-03-14,,,,2,0,2022-03-01 10:00:00+0000,,"
        "1,Europe/Berlin,0,0,List,0,1,tt-task-1,\n"
    ).encode("utf-8")


def build_ticktick_notes() -> bytes:
    return (
        TICKTICK_HEADER
        + "\n"
        + 'Work,Work,Real task,,,N,2022-03-14,,,,2,0,2022-03-01 10:00:00+0000,,'
        "1,Europe/Berlin,0,0,List,0,1,tt-task-1,\n"
        + 'Notes,Notes,Buy groceries,household,"Apples\nOranges",N,,,,,,2,'
        ",,,,1,,,tt-note-1,\n"
    ).encode("utf-8")


TODOIST_CSV = (
    "TYPE,CONTENT,PRIORITY,INDENT,AUTHOR,DATE,LABELS,PROJECT\n"
    ",Design landing page,4,1,me,2022-03-14,web,Website\n"
    ",Review copy,3,1,me,2022-03-15,web,Website\n"
    ",Write blog post,2,2,me,2022-03-16,writing,Blog\n"
    "Completed,Finish report,1,1,me,2022-03-17,work,Reports\n"
).encode("utf-8")

GENERIC_CSV = (
    "title,start date,due date,description,priority,status,tags,unknown_column\n"
    'Task A,2022-03-14,2022-03-14,Do stuff,1,todo,alpha,"ignored value"\n'
    "Task B,2022-03-15,2022-03-15,,2,done,beta,xxx\n"
).encode("utf-8")

ICS_CONTENT = (
    "BEGIN:VCALENDAR\n"
    "VERSION:2.0\n"
    "PRODID:-//Test//EN\n"
    "BEGIN:VTODO\n"
    "SUMMARY:Book flight\n"
    "DESCRIPTION:Book the flight for the conference.\n"
    "DTSTART;TZID=Europe/Berlin:20220314T193102\n"
    "DUE:20220315T100000Z\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO\n"
    "STATUS:COMPLETED\n"
    "COMPLETED:20220315T080000Z\n"
    "CATEGORIES:travel,personal\n"
    "PRIORITY:1\n"
    "END:VTODO\n"
    "BEGIN:VEVENT\n"
    "SUMMARY:Team standup\n"
    "DESCRIPTION:Folded\n"
    " line here\n"
    "DTSTART:20220316T090000Z\n"
    "DTEND:20220316T093000Z\n"
    "END:VEVENT\n"
    "END:VCALENDAR\n"
).encode("utf-8")


ICS_WITH_ALARM = (
    "BEGIN:VCALENDAR\n"
    "VERSION:2.0\n"
    "PRODID:-//Test//EN\n"
    "BEGIN:VTODO\n"
    "SUMMARY:Alarmed task\n"
    "BEGIN:VALARM\n"
    "ACTION:DISPLAY\n"
    "DESCRIPTION:Reminder text\n"
    "TRIGGER:-PT15M\n"
    "END:VALARM\n"
    "DUE:20220315T100000Z\n"
    "END:VTODO\n"
    "END:VCALENDAR\n"
).encode("utf-8")

TICKTICK_LOWERCASE_CSV = (
    "folder name,list name,title,tags,content,is check list,start date,due date,"
    "reminder,repeat,priority,status,created time,completed time,order,time zone,"
    "is all day,is floating,column name,column order,view mode,task id,parent id\n"
    "Work,Work,Case insensitive task,web,,n,2022-03-14,,,,4,1,"
    "2022-03-01 10:00:00+0000,,1,europe/berlin,0,0,list,0,1,ci-1,\n"
).encode("utf-8")

TODOIST_LOWERCASE_CSV = (
    "type,content,priority,indent,author,date,labels,project\n"
    ",Lowercase todoist,4,1,me,2022-03-14,web,Website\n"
).encode("utf-8")


async def get_task_by_title(
    db_session: AsyncSession, title: str, top_level_only: bool = True
) -> Task | None:
    stmt = select(Task).where(Task.title == title)
    if top_level_only:
        stmt = stmt.where(Task.parent_task_id.is_(None))
    result = await db_session.execute(stmt)
    return result.scalar_one_or_none()


@pytest.mark.asyncio
async def test_import_ticktick_tasks_tags_recurrence_subtasks(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_rows(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 2
    assert body["skipped"] == 0
    assert body["failed"] == 0
    assert body["notes_imported"] == 0

    parent = await get_task_by_title(db_session, "Hire contractor")
    assert parent is not None
    # TickTick priority 5 must land on Prysm tier 1 (high), never be folded to 3.
    assert parent.priority == 1
    assert parent.status.value == "todo"
    assert parent.start_date == date(2022, 3, 14)
    assert parent.due_date == date(2022, 3, 15)
    assert parent.recurrence_rule == "FREQ=WEEKLY;BYDAY=MO"
    assert parent.parent_task_id is None

    child = await get_task_by_title(db_session, "Pay invoice", top_level_only=False)
    assert child is not None
    assert child.parent_task_id == parent.id
    assert child.priority == 2
    assert child.status.value == "done"
    assert child.completed_at is not None
    assert child.is_archived is False

    tag_result = await db_session.execute(
        select(Tag).where(Tag.name.in_(["web", "work", "List: Work", "Folder: Work"]))
    )
    tag_names = {t.name for t in tag_result.scalars().all()}
    assert tag_names == {"web", "work", "List: Work", "Folder: Work"}
    links = await db_session.execute(
        select(TaskTag).where(TaskTag.task_id == parent.id)
    )
    assert len(links.scalars().all()) == 4


@pytest.mark.asyncio
async def test_import_ticktick_checklist_creates_subtasks(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_checklist(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    # 1 parent task + 3 checklist subtasks.
    assert body["imported"] == 4
    assert body["failed"] == 0

    parent = await get_task_by_title(db_session, "Launch checklist")
    assert parent is not None
    # Checklist markers are stripped from the description, not duplicated.
    assert parent.description is None

    items = {}
    result = await db_session.execute(
        select(Task).where(Task.parent_task_id == parent.id)
    )
    for t in result.scalars().all():
        items[t.title] = t
    assert set(items.keys()) == {"Prep assets", "Send to review", "Publish"}
    assert items["Prep assets"].status.value == "todo"
    assert items["Publish"].status.value == "done"


@pytest.mark.asyncio
async def test_import_ticktick_notes_as_notes(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_notes(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "true"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 1
    assert body["notes_imported"] == 1
    assert body["failed"] == 0

    task = await get_task_by_title(db_session, "Real task")
    assert task is not None

    result = await db_session.execute(
        select(Note).where(Note.title == "Buy groceries")
    )
    note = result.scalar_one_or_none()
    assert note is not None
    assert note.id.startswith("imp-")
    assert note.content == "Apples\nOranges"

    # Re-importing the same file is idempotent for notes too.
    second = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_notes(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "true"},
    )
    assert second.status_code == 200
    body2 = second.json()
    assert body2["imported"] == 0
    assert body2["skipped"] == 2  # the duplicated task + the duplicated note
    assert body2["notes_imported"] == 0


@pytest.mark.asyncio
async def test_import_todoist_priority_and_status_mapping(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("todoist.csv", TODOIST_CSV, "text/csv")},
        data={"format": "todoist", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    assert response.json()["imported"] == 4

    landing = await get_task_by_title(db_session, "Design landing page")
    assert landing is not None
    assert landing.priority == 1  # Todoist 4 (urgent) -> tier 1
    assert landing.start_date == date(2022, 3, 14)

    review = await get_task_by_title(db_session, "Review copy")
    assert review is not None
    assert review.priority == 2  # Todoist 3 -> tier 2

    blog = await get_task_by_title(db_session, "Write blog post", top_level_only=False)
    assert blog is not None
    assert blog.priority == 2  # Todoist 2 -> tier 2
    # INDENT 2 follows INDENT 1 "Review copy", so it nests under that task.
    assert blog.parent_task_id == review.id

    report = await get_task_by_title(db_session, "Finish report")
    assert report is not None
    assert report.status.value == "done"  # TYPE=Completed
    assert report.priority == 3  # Todoist 1 (low) -> tier 3


@pytest.mark.asyncio
async def test_import_generic_csv_auto_detect(client: AsyncClient, db_session: AsyncSession):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("backup.csv", GENERIC_CSV, "text/csv")},
        data={"format": "auto", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 2
    assert body["failed"] == 0

    a = await get_task_by_title(db_session, "Task A")
    assert a is not None
    assert a.start_date == date(2022, 3, 14)
    assert a.due_date == date(2022, 3, 14)
    assert a.priority == 1
    assert a.description == "Do stuff"

    b = await get_task_by_title(db_session, "Task B")
    assert b is not None
    assert b.status.value == "done"
    assert b.start_date == date(2022, 3, 15)
    assert b.due_date == date(2022, 3, 15)

    tag_result = await db_session.execute(select(Tag).where(Tag.name == "alpha"))
    assert tag_result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_import_ics_vtodo(client: AsyncClient, db_session: AsyncSession):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("calendar.ics", ICS_CONTENT, "text/calendar")},
        data={"format": "ics", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 2
    assert body["failed"] == 0

    flight = await get_task_by_title(db_session, "Book flight")
    assert flight is not None
    assert flight.status.value == "done"
    assert flight.completed_at is not None
    assert flight.start_date == date(2022, 3, 14)
    assert flight.due_date == date(2022, 3, 15)
    assert flight.recurrence_rule == "FREQ=WEEKLY;BYDAY=MO"
    assert flight.priority == 1

    tag_result = await db_session.execute(
        select(Tag).where(Tag.name.in_(["travel", "personal"]))
    )
    assert {t.name for t in tag_result.scalars().all()} == {"travel", "personal"}

    standup = await get_task_by_title(db_session, "Team standup")
    assert standup is not None
    # RFC 5545 folding: CRLF + leading space is the continuation marker, so the
    # folded value unfolds to "Foldedline here" (marker space removed).
    assert standup.description == "Foldedline here"
    assert standup.start_date == date(2022, 3, 16)


@pytest.mark.asyncio
async def test_import_ics_nested_alarm_keeps_summary(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("alarm.ics", ICS_WITH_ALARM, "text/calendar")},
        data={"format": "ics", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    # A VALARM nested inside a VTODO must not clobber the parent SUMMARY (the
    # pre-fix parser reset the component on every BEGIN: and skipped the task).
    assert body["imported"] == 1
    assert body["failed"] == 0

    task = await get_task_by_title(db_session, "Alarmed task")
    assert task is not None
    assert task.due_date == date(2022, 3, 15)


@pytest.mark.asyncio
async def test_import_ticktick_case_insensitive_headers_and_timezone_alias(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", TICKTICK_LOWERCASE_CSV, "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 1
    assert body["failed"] == 0

    task = await get_task_by_title(db_session, "Case insensitive task")
    assert task is not None
    assert task.priority == 1  # TickTick 4 -> tier 1
    assert task.status.value == "done"
    assert task.start_date == date(2022, 3, 14)


@pytest.mark.asyncio
async def test_import_todoist_lowercase_headers(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("todoist.csv", TODOIST_LOWERCASE_CSV, "text/csv")},
        data={"format": "todoist", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    assert response.json()["imported"] == 1

    task = await get_task_by_title(db_session, "Lowercase todoist")
    assert task is not None
    assert task.priority == 1
    assert task.start_date == date(2022, 3, 14)


@pytest.mark.asyncio
async def test_import_dedupe_skips_reimport(client: AsyncClient):
    data = {"format": "generic", "notes_as_notes": "false"}

    first = await client.post(
        "/api/imports/tasks",
        files={"file": ("backup.csv", GENERIC_CSV, "text/csv")},
        data=data,
    )
    assert first.json()["imported"] == 2

    second = await client.post(
        "/api/imports/tasks",
        files={"file": ("backup.csv", GENERIC_CSV, "text/csv")},
        data=data,
    )
    body = second.json()
    assert body["imported"] == 0
    assert body["skipped"] == 2
    assert body["failed"] == 0


@pytest.mark.asyncio
async def test_import_response_shape_is_stable(client: AsyncClient):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("todoist.csv", TODOIST_CSV, "text/csv")},
        data={"format": "auto", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {
        "imported", "skipped", "failed", "notes_imported", "errors",
        "batch_id", "total_rows",
    }
    assert isinstance(body["imported"], int)
    assert isinstance(body["skipped"], int)
    assert isinstance(body["failed"], int)
    assert isinstance(body["notes_imported"], int)
    assert isinstance(body["errors"], list)
    assert isinstance(body["batch_id"], str)
    assert body["total_rows"] == 4
    assert len(body["batch_id"]) == 36  # uuid4 string


@pytest.mark.asyncio
async def test_import_sets_batch_id_on_tasks_and_notes(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_notes(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "true"},
    )
    assert response.status_code == 200
    body = response.json()
    batch_id = body["batch_id"]

    task = await get_task_by_title(db_session, "Real task")
    assert task is not None
    assert str(task.import_batch_id) == batch_id

    note_result = await db_session.execute(
        select(Note).where(Note.title == "Buy groceries")
    )
    note = note_result.scalar_one_or_none()
    assert note is not None
    assert str(note.import_batch_id) == batch_id


@pytest.mark.asyncio
async def test_import_undo_deletes_batch_descendants_and_notes(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_rows(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["imported"] == 2
    batch_id = body["batch_id"]

    total_before = len(
        (await db_session.execute(select(Task.id))).scalars().all()
    )

    undo = await client.post("/api/imports/tasks/undo", json={"batch_id": batch_id})
    assert undo.status_code == 200
    ubody = undo.json()
    assert ubody["deleted_tasks"] == total_before
    assert ubody["deleted_notes"] == 0

    assert await get_task_by_title(db_session, "Hire contractor") is None
    assert await get_task_by_title(db_session, "Pay invoice", top_level_only=False) is None


@pytest.mark.asyncio
async def test_import_undo_removes_recurrence_occurrences(
    client: AsyncClient, db_session: AsyncSession
):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("ticktick.csv", build_ticktick_rows(), "text/csv")},
        data={"format": "ticktick", "notes_as_notes": "false"},
    )
    assert response.status_code == 200
    batch_id = response.json()["batch_id"]

    # The weekly template expands occurrences at import; undo must remove the
    # batch plus every occurrence (and the child) via the descendant walk.
    total_before = len(
        (await db_session.execute(select(Task.id))).scalars().all()
    )
    assert total_before > 2

    undo = await client.post("/api/imports/tasks/undo", json={"batch_id": batch_id})
    assert undo.status_code == 200
    assert undo.json()["deleted_tasks"] == total_before

    result = await db_session.execute(select(Task))
    assert len(result.scalars().all()) == 0


@pytest.mark.asyncio
async def test_import_undo_foreign_or_missing_batch_404(client: AsyncClient):
    response = await client.post(
        "/api/imports/tasks/undo",
        json={"batch_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert response.status_code == 404

    response = await client.post(
        "/api/imports/tasks/undo", json={"batch_id": "not-a-uuid"}
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_import_row_cap_returns_400(
    client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "import_max_rows", 2)
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("todoist.csv", TODOIST_CSV, "text/csv")},
        data={"format": "todoist", "notes_as_notes": "false"},
    )
    assert response.status_code == 400
    assert "Split the file" in response.json()["detail"]

    # Nothing was inserted (the cap rejects before any DB work).
    result = await db_session.execute(select(Task))
    assert len(result.scalars().all()) == 0


@pytest.mark.asyncio
async def test_import_single_flight_returns_409(
    client: AsyncClient, test_user
):
    import app.routers.imports as imports_module

    # Simulate an import already in flight for this account.
    imports_module._active_imports.add(str(test_user.id))
    try:
        response = await client.post(
            "/api/imports/tasks",
            files={"file": ("todoist.csv", TODOIST_CSV, "text/csv")},
            data={"format": "todoist", "notes_as_notes": "false"},
        )
        assert response.status_code == 409
        assert "already running" in response.json()["detail"]
    finally:
        imports_module._active_imports.clear()


@pytest.mark.asyncio
async def test_import_rejects_invalid_format(client: AsyncClient):
    response = await client.post(
        "/api/imports/tasks",
        files={"file": ("x.csv", GENERIC_CSV, "text/csv")},
        data={"format": "nope", "notes_as_notes": "false"},
    )
    assert response.status_code == 422
