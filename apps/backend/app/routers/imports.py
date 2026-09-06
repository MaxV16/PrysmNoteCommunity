"""Import tasks from TickTick / Todoist / generic CSV and iCalendar exports.

Server-side parse + insert (POST /api/imports/tasks). The heavy parsing runs in
``asyncio.to_thread`` so a large file never blocks the event loop, and the DB
session is never held open across a parse. Per-row failures are collected and
reported in a 200 response instead of aborting the whole import.
"""

import asyncio
import csv
import io
import re
import uuid
from datetime import date as date_type
from datetime import datetime, timezone
from typing import Any

from dateutil.rrule import rrulestr
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.note import Note
from app.models.tag import Tag
from app.models.task import Task, TaskStatus
from app.models.task_tag import TaskTag
from app.models.user import User
from app.services.task_service import create_task
from app.utils.priority import normalize_priority

router = APIRouter(prefix="/api/imports", tags=["imports"])

VALID_FORMATS = {"auto", "ticktick", "todoist", "generic", "ics"}

# Per-user single-flight guard: only one import may run per account at a time.
# Module state is process-local, which is exactly right on the single-worker VM.
_active_imports: set[str] = set()


class UndoImportRequest(BaseModel):
    batch_id: str

TICKTICK_HEADER = ("Folder Name", "List Name", "Title", "Tags", "Content", "Is Check list")
TODOIST_HEADER = ("TYPE", "CONTENT", "PRIORITY", "INDENT")

# Commit cadence: a failing late row never discards earlier progress, and the
# transaction stays small enough to keep RLS re-set cheap after each commit.
COMMIT_EVERY = 200

CHECKLIST_MARKER_RE = re.compile(r"^[▫▪\-*•]\s*(?:\[([ xX])\]\s*)?(.*)$")
CHECKBOX_RE = re.compile(r"^\[([ xX])\]\s*(.*)$")
CONCAT_CHECKLIST_RE = re.compile(
    r"[▫▪•*\-](?:\s*\[([ xX])\]\s*)?([^▫▪•*\n]+)"
)
TITLE_SYNONYMS = {"title", "name", "subject", "task", "task title", "taskname", "task_name"}
DUE_SYNONYMS = {"due", "due date", "due_date", "duedate", "deadline"}
START_SYNONYMS = {"start", "start date", "start_date", "startdate", "begin"}
DESC_SYNONYMS = {"notes", "description", "body", "details", "content", "note", "comments"}
TAGS_SYNONYMS = {"tags", "labels", "tag", "label"}
PRIORITY_SYNONYMS = {"priority"}
STATUS_SYNONYMS = {"status", "state"}
RECURRENCE_SYNONYMS = {"repeat", "recurrence", "rrule", "recurrence_rule", "recurrence rule"}
COMPLETED_SYNONYMS = {"completed", "completed at", "completed_at", "done", "date completed"}
ARCHIVED_SYNONYMS = {"archived", "is_archived", "archived at"}
PARENT_SYNONYMS = {
    "parent", "parent id", "parent_id", "parent title", "parent_title",
    "subtask of", "sub task",
}


# --------------------------------------------------------------------------
# Date helpers
# --------------------------------------------------------------------------

def _decode(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return content.decode(encoding)
        except (UnicodeDecodeError, ValueError):
            continue
    return content.decode("utf-8", errors="replace")


def _dt_to_local_date(dt: datetime, tz_name: str | None) -> date_type:
    """Convert a datetime to a date in the row's timezone (else UTC).

    A 18:30 start in the user's local day must land on that day, not UTC's. Any
    TZID lookup failure falls back to UTC (import must never crash on one row).
    """
    if dt.tzinfo is None:
        return dt.date()
    if tz_name:
        try:
            from zoneinfo import ZoneInfo

            return dt.astimezone(ZoneInfo(tz_name)).date()
        except Exception:
            pass
    return dt.astimezone(timezone.utc).date()


def _parse_dt(value: str | None) -> datetime | None:
    """Parse a loose export timestamp into a datetime (naive or aware)."""
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    try:
        return datetime.combine(date_type.fromisoformat(v), datetime.min.time())
    except (ValueError, TypeError):
        pass
    for fmt in (
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ):
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            continue
    try:
        from dateutil import parser as dateutil_parser

        return dateutil_parser.parse(v)
    except Exception:
        return None


def _parse_date_value(value: str | None, tz_name: str | None = None) -> date_type | None:
    dt = _parse_dt(value)
    if dt is None:
        return None
    return _dt_to_local_date(dt, tz_name)


def _parse_ics_dt(value: str, tz_name: str | None) -> date_type | None:
    """Parse an ICS property value (compact / ISO / date-only / Z / TZID)."""
    v = value.strip()
    if not v:
        return None
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", v)
    if m:
        try:
            return date_type(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|z)?", v)
    if m:
        try:
            dt = datetime(
                int(m[1]), int(m[2]), int(m[3]),
                int(m[4]), int(m[5]), int(m[6]) if m[6] else 0,
                tzinfo=timezone.utc if m[7] else None,
            )
        except ValueError:
            return None
        return _dt_to_local_date(dt, tz_name)
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _dt_to_local_date(dt, tz_name)


def _valid_rrule(rule: str | None) -> str | None:
    """Return the RRULE body if it parses, else None (the field is dropped).

    ``create_task`` runs the same parse inside occurrence expansion, so an
    invalid rule from a source file would 500 the whole import. Validate first
    and let the caller record a row warning.
    """
    if not rule:
        return None
    body = rule.strip()
    if body.upper().startswith("RRULE:"):
        body = body[len("RRULE:"):]
    body = body.strip()
    if not body:
        return None
    try:
        rrulestr(f"RRULE:{body}")
        return body
    except Exception:
        return None


# --------------------------------------------------------------------------
# Priority / status mapping (pre-mapped to Prysm tiers 1/2/3 - the service's
# normalize_priority would otherwise fold source high values into low=3).
# --------------------------------------------------------------------------

_TEXT_HIGH = {"urgent", "high", "p1", "p2"}
_TEXT_MEDIUM = {"medium", "normal", "p3"}
_TEXT_LOW = {"low", "p4", "p5", "none", ""}


def _map_priority(value: str | None, scale: str) -> int:
    """Map a source priority (numeric per-source scale or free text) to Prysm's
    tiers 1=high, 2=medium, 3=low. Empty and unknown values land on neutral.
    """
    v = (value or "").strip().lower()
    if not v:
        return 2
    if v in _TEXT_HIGH:
        return 1
    if v in _TEXT_MEDIUM:
        return 2
    if v in _TEXT_LOW:
        return 3
    try:
        p = int(v)
    except ValueError:
        return 2
    if scale == "ticktick":
        # TickTick canonical export scale: 0=none, 1=low, 3=medium, 5=high
        # (2/4 are legacy values in the same scale).
        if p <= 0:
            return 2
        if p <= 2:
            return 3
        if p <= 4:
            return 2
        return 1
    if scale == "todoist":
        # Todoist: 4=urgent, 3=high, 2=medium, 1=low.
        if p <= 1:
            return 3
        if p <= 3:
            return 2
        return 1
    if scale == "ics":
        # RFC 5545: 1=highest ... 9=lowest, 0 = undefined.
        if p == 0:
            return 2
        if p <= 2:
            return 1
        if p <= 6:
            return 2
        return 3
    # generic: 1=high, 2=medium, anything higher folds to low.
    if p <= 1:
        return 1
    if p == 2:
        return 2
    return 3


def _map_ticktick_priority(value: str | None) -> int:
    return _map_priority(value, "ticktick")


def _map_todoist_priority(value: str | None) -> int:
    return _map_priority(value, "todoist")


def _map_ics_priority(value: str | None) -> int:
    return _map_priority(value, "ics")


def _map_generic_priority(value: str | None) -> int:
    return _map_priority(value, "generic")


def _normalize_status(value: str | None) -> tuple[str, bool]:
    """Map a loose status string to (prysm_status, is_archived)."""
    v = (value or "").strip().lower()
    if not v:
        return "todo", False
    if v in {"done", "completed", "complete", "finished", "x", "1", "true"}:
        return "done", False
    if v in {"archived", "archive"}:
        return "todo", True
    if v in {"in_progress", "in progress", "doing"}:
        return "in_progress", False
    if v in {"cancelled", "canceled", "cancelled"}:
        return "cancelled", False
    return "todo", False


def _split_tags(value: str | None) -> list[str]:
    out = []
    for part in (value or "").split(","):
        tag = part.strip()
        if tag:
            out.append(tag)
    return out


def _unescape_ics(value: str) -> str:
    return (
        value.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


# --------------------------------------------------------------------------
# Format detection
# --------------------------------------------------------------------------

def _detect_format(filename: str, content: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".ics"):
        return "ics"
    if "todoist" in name:
        return "todoist"
    if "ticktick" in name:
        return "ticktick"
    text = _decode(content)
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("BEGIN:VCALENDAR"):
            return "ics"
        lower = stripped.lower()
        if "folder name" in lower and "list name" in lower and "title" in lower:
            return "ticktick"
        if lower.startswith("type") and "content" in lower:
            return "todoist"
        break
    return "generic"


def _csv_read_all(text: str) -> list[list[str]]:
    """Parse a CSV stream into rows, skipping fully blank records.

    Reads from the full text (not pre-split lines) so embedded newlines inside
    quoted fields survive (e.g. a TickTick note body spanning two lines).
    """
    return [
        row
        for row in csv.reader(io.StringIO(text))
        if any(cell.strip() for cell in row)
    ]


def _csv_dicts(header: list[str], data_rows: list[list[str]]) -> list[dict[str, str]]:
    out = []
    for row in data_rows:
        out.append(dict(zip(header, row + [""] * (len(header) - len(row)))))
    return out


def _pick(rowmap: dict[str, str], *aliases: str) -> str:
    """Case-insensitive cell lookup by any of several header aliases."""
    for key in aliases:
        if key in rowmap:
            return rowmap[key]
    return ""


def _row_map(row: dict[str, str]) -> dict[str, str]:
    return {k.strip().lower(): (v or "") for k, v in row.items()}


TICKTICK_FIELDS: dict[str, tuple[str, ...]] = {
    "title": ("title",),
    "content": ("content",),
    "list": ("list name", "list"),
    "folder": ("folder name", "folder"),
    "tags": ("tags",),
    "checklist": ("is check list", "ischecklist", "is checklist"),
    "start": ("start date", "startdate", "start"),
    "due": ("due date", "duedate", "due"),
    "completed": ("completed time", "completedtime", "completed"),
    "created": ("created time", "createdtime", "created"),
    "repeat": ("repeat", "recurrence", "rrule"),
    "priority": ("priority",),
    "status": ("status",),
    "tz": ("timezone", "time zone", "tz"),
    "taskid": ("taskid", "task id", "task_id"),
    "parentid": ("parentid", "parent id", "parent_id"),
}

TODOIST_FIELDS: dict[str, tuple[str, ...]] = {
    "type": ("type",),
    "content": ("content",),
    "priority": ("priority",),
    "indent": ("indent",),
    "date": ("date",),
    "labels": ("labels",),
    "project": ("project_name", "project_id", "project name", "project id", "project"),
    "description": ("description", "desc"),
}


# --------------------------------------------------------------------------
# Parsers (sync - run inside asyncio.to_thread)
# --------------------------------------------------------------------------

def _is_ticktick_header(row: list[str]) -> bool:
    lower = [(c or "").strip().lower() for c in row]
    has_title = any("title" in c for c in lower)
    score = 0
    if any("task" in c and "id" in c for c in lower):
        score += 1
    if any("parent" in c and "id" in c for c in lower):
        score += 1
    if any("check list" in c or "checklist" in c for c in lower):
        score += 1
    if any("folder" in c for c in lower):
        score += 1
    if any("list" in c for c in lower):
        score += 1
    # Some backups omit the taskId/parentId columns entirely, so a title kit
    # plus any two other TickTick markers is enough to recognize the header.
    return has_title and score >= 2


def _parse_ticktick(content: bytes) -> list[dict]:
    text = _decode(content)
    all_rows = _csv_read_all(text)
    header_idx = -1
    for i, row in enumerate(all_rows):
        if _is_ticktick_header(row):
            header_idx = i
            break
    if header_idx < 0:
        return []
    header = all_rows[header_idx]
    data_rows = _csv_dicts(header, all_rows[header_idx + 1:])

    # Real child rows reference their parent by the parentId cell. When real
    # children exist for a checklist parent, prefer them over the checklist
    # markers so the same subtask is not imported twice (TickTick can store
    # both forms for one task).
    referenced_parent_keys: set[str] = set()
    for raw_row in data_rows:
        pk = _pick(_row_map(raw_row), *TICKTICK_FIELDS["parentid"]).strip()
        if pk:
            referenced_parent_keys.add(pk)

    rows: list[dict] = []
    for ordinal, raw_row in enumerate(data_rows):
        row = _row_map(raw_row)
        list_name = _pick(row, *TICKTICK_FIELDS["list"]).strip()
        folder_name = _pick(row, *TICKTICK_FIELDS["folder"]).strip()
        title = _pick(row, *TICKTICK_FIELDS["title"]).strip()
        content_value = _pick(row, *TICKTICK_FIELDS["content"])
        if not title and not content_value:
            continue
        tz_name = _pick(row, *TICKTICK_FIELDS["tz"]).strip() or None
        start_date = _parse_date_value(
            _pick(row, *TICKTICK_FIELDS["start"]), tz_name
        )
        due_date = _parse_date_value(_pick(row, *TICKTICK_FIELDS["due"]), tz_name)
        completed_at = _parse_dt(_pick(row, *TICKTICK_FIELDS["completed"]))
        created_at = _parse_dt(_pick(row, *TICKTICK_FIELDS["created"]))
        if completed_at is not None and tz_name:
            completed_at = completed_at.astimezone(
                _tz_or_utc(tz_name)
            ) if completed_at.tzinfo else completed_at
        if created_at is not None and tz_name:
            created_at = created_at.astimezone(
                _tz_or_utc(tz_name)
            ) if created_at.tzinfo else created_at

        is_checklist = _pick(
            row, *TICKTICK_FIELDS["checklist"]
        ).strip().upper() in ("Y", "TRUE", "1")
        is_note = list_name.lower() == "notes"

        status_value, archived = _map_ticktick_status(
            _pick(row, *TICKTICK_FIELDS["status"]), completed_at
        )

        tags = _split_tags(_pick(row, *TICKTICK_FIELDS["tags"]))
        if list_name:
            tags.append(f"List: {list_name}")
        if folder_name:
            tags.append(f"Folder: {folder_name}")

        # Backups often leave the id columns empty. Fall back to a stable
        # ordinal key so checklist items (and dedupe on re-import) still work.
        taskid_cell = _pick(row, *TICKTICK_FIELDS["taskid"]).strip()
        source_key = taskid_cell or f"row-{ordinal}"
        parent_key = _pick(row, *TICKTICK_FIELDS["parentid"]).strip() or None
        repeat_raw = _pick(row, *TICKTICK_FIELDS["repeat"])

        entry: dict[str, Any] = {
            "title": title or _first_content_line(content_value),
            "description": _checklist_stripped(content_value) if is_checklist else (content_value or None),
            "start_date": start_date,
            "due_date": due_date,
            "recurrence_rule": _valid_rrule(repeat_raw) or None,
            "priority": _map_ticktick_priority(_pick(row, *TICKTICK_FIELDS["priority"])),
            "status": status_value,
            "is_archived": archived,
            "completed_at": completed_at,
            "created_at": created_at,
            "tags": tags,
            "source_key": source_key,
            "parent_key": parent_key,
            "is_note": is_note,
            "note_content": content_value or None,
            "timezone": tz_name,
        }
        if entry["recurrence_rule"] is None and repeat_raw.strip():
            entry["warning"] = "Invalid recurrence rule dropped"
        rows.append(entry)
        if is_checklist and source_key not in referenced_parent_keys:
            for item_idx, (item, done) in enumerate(
                _parse_checklist_items(content_value)
            ):
                rows.append({
                    "title": item,
                    "description": None,
                    "start_date": start_date,
                    "due_date": due_date,
                    "recurrence_rule": None,
                    "priority": _map_ticktick_priority(_pick(row, *TICKTICK_FIELDS["priority"])),
                    "status": "done" if done else "todo",
                    "is_archived": False,
                    "completed_at": completed_at if done else None,
                    "created_at": created_at,
                    "tags": list(tags),
                    "source_key": f"{source_key}#{item_idx}",
                    "parent_key": source_key,
                    "is_note": False,
                    "note_content": None,
                    "timezone": tz_name,
                })
    return rows


def _map_ticktick_status(value: str | None, completed_at: datetime | None) -> tuple[str, bool]:
    v = (value or "").strip()
    if v == "1":
        return "done", False
    if v == "2":
        return "todo", True
    return "todo", False


def _tz_or_utc(tz_name: str):
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(tz_name)
    except Exception:
        return timezone.utc


def _first_content_line(content: str) -> str:
    for line in (content or "").splitlines():
        s = line.strip()
        if s:
            return s
    return ""


def _checklist_stripped(content: str) -> str | None:
    kept = []
    for line in (content or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if CHECKLIST_MARKER_RE.match(s) or CHECKBOX_RE.match(s):
            continue
        kept.append(line)
    return "\n".join(kept).strip() or None


def _parse_checklist_items(content: str) -> list[tuple[str, bool]]:
    content = content or ""
    lines = content.splitlines()
    # TickTick sometimes concatenates checklist items onto one line with no
    # line breaks (e.g. "▫ A▪ B▫ C"). A single line never needs newline
    # splitting, so scan it for consecutive marker runs directly.
    if len(lines) <= 1:
        items = []
        for m in CONCAT_CHECKLIST_RE.finditer(content):
            done = bool(m.group(1) and m.group(1).lower() == "x")
            label = m.group(2).strip()
            if label:
                items.append((label, done))
        if items:
            return items
    items = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        m = CHECKLIST_MARKER_RE.match(s)
        done = False
        label = ""
        if m:
            done = bool(m.group(1) and m.group(1).lower() == "x")
            label = m.group(2).strip()
        else:
            cb = CHECKBOX_RE.match(s)
            if cb:
                done = cb.group(1).lower() == "x"
                label = cb.group(2).strip()
            else:
                continue
        if label:
            items.append((label, done))
    return items


def _parse_todoist(content: bytes) -> list[dict]:
    text = _decode(content)
    all_rows = _csv_read_all(text)
    if not all_rows:
        return []
    header = all_rows[0]
    rows: list[dict] = []
    stack: list[tuple[int, str]] = []
    for raw_row in _csv_dicts(header, all_rows[1:]):
        row = _row_map(raw_row)
        title = _pick(row, *TODOIST_FIELDS["content"]).strip()
        if not title:
            continue
        indent = 1
        try:
            indent = int(_pick(row, *TODOIST_FIELDS["indent"]).strip() or "1")
        except ValueError:
            pass
        indent = max(1, indent)
        source_key = uuid.uuid4().hex
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent_key = stack[-1][1] if stack else None
        stack.append((indent, source_key))

        row_type = _pick(row, *TODOIST_FIELDS["type"]).strip().lower()
        is_done = bool(row_type) and "completed" in row_type
        is_note = row_type == "note"
        due = _parse_date_value(_pick(row, *TODOIST_FIELDS["date"]))
        project = _pick(row, *TODOIST_FIELDS["project"]).strip()
        tags = _split_tags(_pick(row, *TODOIST_FIELDS["labels"]))
        if project:
            tags.append(f"Project: {project}")
        desc = _pick(row, *TODOIST_FIELDS["description"]).strip() or None

        rows.append({
            "title": title,
            "description": desc,
            "start_date": due,
            "due_date": due,
            "recurrence_rule": None,
            "priority": _map_todoist_priority(_pick(row, *TODOIST_FIELDS["priority"])),
            "status": "done" if is_done else "todo",
            "is_archived": False,
            "completed_at": None,
            "created_at": None,
            "tags": tags,
            "source_key": source_key,
            "parent_key": parent_key,
            "is_note": is_note,
            "note_content": title if is_note else None,
            "timezone": None,
        })
    return rows


def _parse_generic(content: bytes) -> list[dict]:
    text = _decode(content)
    all_rows = _csv_read_all(text)
    if not all_rows:
        return []
    header = all_rows[0]
    field_map: dict[str, str] = {}
    for f in header:
        key = (f or "").strip().lower()
        if key in TITLE_SYNONYMS:
            field_map.setdefault("title", f)
        elif key in DUE_SYNONYMS:
            field_map.setdefault("due", f)
        elif key in START_SYNONYMS:
            field_map.setdefault("start", f)
        elif key in DESC_SYNONYMS:
            field_map.setdefault("desc", f)
        elif key in TAGS_SYNONYMS:
            field_map.setdefault("tags", f)
        elif key in PARENT_SYNONYMS:
            field_map.setdefault("parent", f)
        elif key in PRIORITY_SYNONYMS:
            field_map.setdefault("priority", f)
        elif key in STATUS_SYNONYMS:
            field_map.setdefault("status", f)
        elif key in RECURRENCE_SYNONYMS:
            field_map.setdefault("recurrence", f)
        elif key in COMPLETED_SYNONYMS:
            field_map.setdefault("completed", f)
        elif key in ARCHIVED_SYNONYMS:
            field_map.setdefault("archived", f)

    rows: list[dict] = []
    for row in _csv_dicts(header, all_rows[1:]):
        title = (row.get(field_map.get("title", "")) or "").strip()
        if not title:
            continue
        start = _parse_date_value(row.get(field_map.get("start", "")))
        due = _parse_date_value(row.get(field_map.get("due", "")))
        desc = (row.get(field_map.get("desc", "")) or "").strip() or None
        rule = (row.get(field_map.get("recurrence", "")) or "").strip() or None
        completed = _parse_dt(row.get(field_map.get("completed", "")))
        status_value, archived = _normalize_status(
            row.get(field_map.get("status", ""))
            or ("done" if completed is not None else None)
        )
        parent_title = (
            row.get(field_map.get("parent", "")) or ""
        ).strip() or None
        rows.append({
            "title": title,
            "description": desc,
            "start_date": start,
            "due_date": due,
            "recurrence_rule": _valid_rrule(rule),
            "priority": _map_generic_priority(row.get(field_map.get("priority", ""))),
            "status": status_value,
            "is_archived": archived
            or (row.get(field_map.get("archived", "")) or "").strip().lower() in ("y", "true", "1"),
            "completed_at": completed,
            "created_at": None,
            "tags": _split_tags(row.get(field_map.get("tags", ""))),
            "source_key": None,
            "parent_key": parent_title,
            "is_note": False,
            "note_content": None,
            "timezone": None,
        })
    return rows


def _parse_ics(content: bytes) -> list[dict]:
    text = _decode(content)
    unfolded: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if line and line[0] in (" ", "\t") and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)

    # Parse components with an explicit stack so nested blocks (VALARM inside
    # VTODO, STANDARD/DAYLIGHT inside VTIMEZONE) never clobber the enclosing
    # task's properties: only props whose immediate parent is VTODO/VEVENT are
    # collected, and only VTODO/VEVENT components become rows.
    components: list[dict] = []
    stack: list[tuple[str, dict]] = []
    for line in unfolded:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.upper().startswith("BEGIN:"):
            name = stripped.split(":", 1)[1].strip().upper()
            stack.append((name, {}))
            continue
        if stripped.upper().startswith("END:"):
            comp = stack.pop() if stack else None
            if comp and comp[0] in ("VTODO", "VEVENT"):
                components.append(comp[1])
            continue
        if not stack:
            continue
        if ":" not in line:
            continue
        key_raw, _, value = line.partition(":")
        key_parts = key_raw.split(";")
        key = key_parts[0].upper()
        params: dict[str, str] = {}
        for part in key_parts[1:]:
            if "=" in part:
                pname, _, pval = part.partition("=")
                params[pname.upper()] = pval
        top_name, top_props = stack[-1]
        if top_name in ("VTODO", "VEVENT"):
            top_props.setdefault(key, []).append((params, value))

    rows: list[dict] = []
    for props in components:
        if "SUMMARY" not in props:
            continue
        tz_name = None
        for params, _v in props.get("DTSTART", []):
            if "TZID" in params:
                tz_name = params["TZID"]
                break
        summary = _unescape_ics(props.get("SUMMARY", [("", "")])[0][1]).strip()
        if not summary:
            continue

        def first(key: str) -> str | None:
            vals = props.get(key)
            if not vals:
                return None
            return vals[0][1]

        start = None
        for params, v in props.get("DTSTART", []):
            tz = params.get("TZID") or tz_name
            start = _parse_ics_dt(v, tz)
            if start is not None:
                break
        due = None
        for key in ("DTEND", "DUE"):
            for params, v in props.get(key, []):
                tz = params.get("TZID") or tz_name
                due = _parse_ics_dt(v, tz)
                if due is not None:
                    break
            if due is not None:
                break

        status_value = "todo"
        status_raw = (first("STATUS") or "").strip().upper()
        completed_at = None
        if status_raw == "COMPLETED":
            status_value = "done"
            completed_at = _parse_dt(first("COMPLETED"))
        elif props.get("COMPLETED"):
            status_value = "done"
            completed_at = _parse_dt(first("COMPLETED"))

        desc = _unescape_ics(first("DESCRIPTION") or "").strip() or None
        rule = _valid_rrule(first("RRULE"))
        categories = props.get("CATEGORIES")
        tags = []
        for _p, v in categories or []:
            tags.extend(t.replace("\\,", ",").strip() for t in v.split(","))
        priority = _map_ics_priority(first("PRIORITY"))
        created_at = _parse_dt(first("CREATED"))

        entry: dict[str, Any] = {
            "title": summary,
            "description": desc,
            "start_date": start,
            "due_date": due,
            "recurrence_rule": rule,
            "priority": priority,
            "status": status_value,
            "is_archived": False,
            "completed_at": completed_at,
            "created_at": created_at,
            "tags": tags,
            "source_key": None,
            "parent_key": None,
            "is_note": False,
            "note_content": None,
            "timezone": tz_name,
        }
        if rule is None and first("RRULE"):
            entry["warning"] = "Invalid recurrence rule dropped"
        rows.append(entry)
    return rows


PARSERS: dict[str, Any] = {
    "ticktick": _parse_ticktick,
    "todoist": _parse_todoist,
    "generic": _parse_generic,
    "ics": _parse_ics,
}


# --------------------------------------------------------------------------
# Insert logic
# --------------------------------------------------------------------------

def _dedupe_key(row: dict) -> tuple:
    return (row.get("title"), row.get("start_date"), row.get("due_date"))


async def _ensure_rls(session: AsyncSession, user_id) -> None:
    """Re-apply the RLS user after every commit (the config is transaction-local)."""
    if session.get_bind().dialect.name == "postgresql":
        from app.utils.rls import set_rls_user_id

        await set_rls_user_id(session, user_id)


async def _load_tag_cache(session: AsyncSession, user_id) -> dict[str, Tag]:
    """Load every existing tag name -> Tag row for the user (one query).

    Imported rows re-use the same tag names over and over (list/folder tags,
    project tags), so a shared cache avoids an N+1 tag lookup per task row.
    """
    result = await session.execute(select(Tag).where(Tag.user_id == user_id))
    return {t.name: t for t in result.scalars().all()}


async def _attach_tags(
    session: AsyncSession,
    task_id,
    user_id,
    names: list[str],
    tag_cache: dict[str, Tag],
) -> None:
    """Get-or-create each tag (from the shared cache) and link it to the task."""
    if not names:
        return
    seen: set[str] = set()
    for raw in names:
        name = (raw or "").strip()
        if not name or len(name) > 50 or name in seen:
            continue
        seen.add(name)
        tag = tag_cache.get(name)
        if tag is None:
            tag = Tag(user_id=user_id, name=name)
            session.add(tag)
            await session.flush()
            tag_cache[name] = tag
        session.add(TaskTag(task_id=task_id, tag_id=tag.id))


def _build_task(
    user_id,
    row: dict,
    parent_task_id=None,
    batch_id=None,
) -> Task | None:
    """Construct a Task ORM row without flushing (mirrors create_task's field
    mapping). Used by the batched-insert path; rows with a recurrence rule use
    create_task instead because it also materializes occurrences."""
    title = (row.get("title") or "").strip()
    if not title or len(title) > 500:
        return None
    status_value = row.get("status") or "todo"
    if not isinstance(status_value, TaskStatus):
        try:
            status_value = TaskStatus(str(status_value))
        except ValueError:
            status_value = TaskStatus.TODO
    return Task(
        user_id=user_id,
        parent_task_id=parent_task_id,
        title=title,
        description=(row.get("description") or None),
        status=status_value,
        priority=normalize_priority(row.get("priority") or 2),
        start_date=row.get("start_date") or None,
        due_date=row.get("due_date") or None,
        recurrence_rule=row.get("recurrence_rule") or None,
        is_archived=bool(row.get("is_archived", False)),
        completed_at=row.get("completed_at"),
        created_at=row.get("created_at"),
        import_batch_id=batch_id,
    )


async def _create_task_from_row(
    session: AsyncSession,
    user_id,
    row: dict,
    tag_cache: dict[str, Tag],
    parent_task_id=None,
    batch_id=None,
) -> Task | None:
    title = (row.get("title") or "").strip()
    if not title or len(title) > 500:
        return None
    task = await create_task(
        session,
        user_id=user_id,
        title=title,
        parent_task_id=parent_task_id,
        description=(row.get("description") or None),
        status=row.get("status") or "todo",
        priority=row.get("priority") or 2,
        start_date=row.get("start_date").isoformat() if row.get("start_date") else None,
        due_date=row.get("due_date").isoformat() if row.get("due_date") else None,
        recurrence_rule=row.get("recurrence_rule") or None,
    )
    task.import_batch_id = batch_id
    if row.get("is_archived"):
        task.is_archived = True
    if row.get("completed_at"):
        task.completed_at = row["completed_at"]
    if row.get("created_at"):
        task.created_at = row["created_at"]
    await _attach_tags(session, task.id, user_id, row.get("tags") or [], tag_cache)
    await session.flush()
    return task


def _build_note(user_id, row: dict, batch_id=None) -> Note:
    return Note(
        id="imp-" + uuid.uuid4().hex,
        user_id=user_id,
        title=(row.get("title") or "")[:300],
        content=(row.get("note_content") or row.get("description") or "")[:20000],
        import_batch_id=batch_id,
    )


async def _create_note_row(session: AsyncSession, user_id, row: dict, batch_id=None) -> None:
    session.add(_build_note(user_id, row, batch_id))
    await session.flush()


async def _run_import(
    session: AsyncSession,
    user_id,
    rows: list[dict],
    notes_as_notes: bool,
    batch_id,
) -> tuple[dict, list[dict]]:
    result = await session.execute(
        select(Task.title, Task.start_date, Task.due_date).where(Task.user_id == user_id)
    )
    existing = {(str(t), s, d) for t, s, d in result.all()}

    # Notes are deduped by (title, content) so re-importing the same TickTick
    # file does not stack duplicate sticky notes.
    note_result = await session.execute(
        select(Note.title, Note.content).where(Note.user_id == user_id)
    )
    existing_notes = {(str(t), str(c)) for t, c in note_result.all()}

    stats = {"imported": 0, "skipped": 0, "failed": 0, "notes_imported": 0}
    errors: list[dict] = []
    parent_ids: dict[str, Any] = {}
    title_ids: dict[str, Any] = {}
    children: list[tuple[int, dict]] = []
    tag_cache = await _load_tag_cache(session, user_id)

    # Batched inserts: simple rows (no recurrence rule) are built as ORM objects
    # and flushed in bulk every COMMIT_EVERY rows instead of one flush per row.
    # Rows with a recurrence rule keep using create_task, which materializes the
    # occurrence series up front. Notes get the same bulk treatment.
    pending: list[tuple[int, dict, Task]] = []
    pending_notes: list[Note] = []

    async def _flush_pending() -> None:
        nonlocal pending, pending_notes
        if pending:
            session.add_all([t for _, _, t in pending])
            await session.flush()
            for idx, row, task in pending:
                if row.get("source_key"):
                    parent_ids[row["source_key"]] = task.id
                title_ids.setdefault((row.get("title") or ""), task.id)
                await _attach_tags(
                    session, task.id, user_id, row.get("tags") or [], tag_cache
                )
                if row.get("warning"):
                    errors.append({"row": idx + 1, "reason": row["warning"]})
            pending = []
        if pending_notes:
            session.add_all(pending_notes)
            await session.flush()
            pending_notes = []

    async def _maybe_commit(processed: int) -> None:
        if processed > 0 and processed % COMMIT_EVERY == 0:
            await session.commit()
            await _ensure_rls(session, user_id)

    processed = 0

    # Pass 1: notes + top-level tasks (children wait for the parent id mapping).
    for idx, row in enumerate(rows):
        if row.get("is_note") and notes_as_notes:
            note_key = ((row.get("title") or ""), (row.get("note_content") or ""))
            if note_key in existing_notes:
                stats["skipped"] += 1
            else:
                pending_notes.append(_build_note(user_id, row, batch_id))
                stats["notes_imported"] += 1
                existing_notes.add(note_key)
            processed += 1
            if len(pending_notes) >= COMMIT_EVERY:
                await _flush_pending()
            await _maybe_commit(processed)
            continue

        parent_key = row.get("parent_key")
        if parent_key:
            children.append((idx, row))
            continue

        if _dedupe_key(row) in existing:
            stats["skipped"] += 1
            processed += 1
            await _maybe_commit(processed)
            continue
        try:
            if row.get("recurrence_rule"):
                task = await _create_task_from_row(
                    session, user_id, row, tag_cache, batch_id=batch_id
                )
                if task is None:
                    stats["skipped"] += 1
                else:
                    existing.add(_dedupe_key(row))
                    if row.get("source_key"):
                        parent_ids[row["source_key"]] = task.id
                    title_ids.setdefault((row.get("title") or ""), task.id)
                    stats["imported"] += 1
                    if row.get("warning"):
                        errors.append({"row": idx + 1, "reason": row["warning"]})
            else:
                task = _build_task(user_id, row, batch_id=batch_id)
                if task is None:
                    stats["skipped"] += 1
                else:
                    existing.add(_dedupe_key(row))
                    pending.append((idx, row, task))
                    stats["imported"] += 1
        except Exception as e:
            stats["failed"] += 1
            errors.append({"row": idx + 1, "reason": str(e)})
        processed += 1
        if len(pending) >= COMMIT_EVERY:
            await _flush_pending()
        await _maybe_commit(processed)

    # Flush the remaining pass-1 batch so every source_key -> task id mapping is
    # available before the children pass reads it (children may be batched too).
    await _flush_pending()

    # Pass 2: subtasks. Children resolve against the source_key -> id (and
    # batch title -> id) maps that grow as rows flush. Deep or out-of-order
    # nesting needs multiple rounds: each round builds every child whose parent
    # is now known, flushes so those ids become resolvable, then retries the
    # remainder. Children whose parent never resolves are promoted to top level
    # so no row is lost, with a warning for the result card.
    worklist: list[tuple[int, dict]] = children
    while worklist:
        remaining: list[tuple[int, dict]] = []
        made_progress = False
        for idx, row in worklist:
            if _dedupe_key(row) in existing:
                stats["skipped"] += 1
                processed += 1
                await _maybe_commit(processed)
                continue
            parent_id = None
            parent_key = row.get("parent_key")
            if parent_key:
                parent_id = parent_ids.get(parent_key)
                if parent_id is None:
                    parent_id = title_ids.get(parent_key)
            if parent_id is None:
                remaining.append((idx, row))
                continue
            made_progress = True
            try:
                if row.get("recurrence_rule"):
                    task = await _create_task_from_row(
                        session, user_id, row, tag_cache,
                        parent_task_id=parent_id, batch_id=batch_id,
                    )
                    if task is None:
                        stats["skipped"] += 1
                    else:
                        existing.add(_dedupe_key(row))
                        if row.get("source_key"):
                            parent_ids[row["source_key"]] = task.id
                        title_ids.setdefault((row.get("title") or ""), task.id)
                        stats["imported"] += 1
                else:
                    task = _build_task(
                        user_id, row, parent_task_id=parent_id, batch_id=batch_id
                    )
                    if task is None:
                        stats["skipped"] += 1
                    else:
                        existing.add(_dedupe_key(row))
                        pending.append((idx, row, task))
                        stats["imported"] += 1
            except Exception as e:
                stats["failed"] += 1
                errors.append({"row": idx + 1, "reason": str(e)})
            processed += 1
            if len(pending) >= COMMIT_EVERY:
                await _flush_pending()
            await _maybe_commit(processed)
        await _flush_pending()
        if not remaining:
            break
        if not made_progress:
            # Orphans: no parent surfaced in any round - import as top level.
            for idx, row in remaining:
                if _dedupe_key(row) in existing:
                    stats["skipped"] += 1
                    processed += 1
                    await _maybe_commit(processed)
                    continue
                try:
                    if row.get("recurrence_rule"):
                        task = await _create_task_from_row(
                            session, user_id, row, tag_cache, batch_id=batch_id
                        )
                        if task is None:
                            stats["skipped"] += 1
                            processed += 1
                            await _maybe_commit(processed)
                            continue
                        existing.add(_dedupe_key(row))
                        if row.get("source_key"):
                            parent_ids[row["source_key"]] = task.id
                        title_ids.setdefault((row.get("title") or ""), task.id)
                        stats["imported"] += 1
                    else:
                        task = _build_task(user_id, row, batch_id=batch_id)
                        if task is None:
                            stats["skipped"] += 1
                            processed += 1
                            await _maybe_commit(processed)
                            continue
                        existing.add(_dedupe_key(row))
                        pending.append((idx, row, task))
                        stats["imported"] += 1
                    errors.append({
                        "row": idx + 1,
                        "reason": "Parent task not found; imported as a top-level task",
                    })
                except Exception as e:
                    stats["failed"] += 1
                    errors.append({"row": idx + 1, "reason": str(e)})
                processed += 1
                if len(pending) >= COMMIT_EVERY:
                    await _flush_pending()
                await _maybe_commit(processed)
            await _flush_pending()
            break
        worklist = remaining

    await _flush_pending()
    await session.commit()
    await _ensure_rls(session, user_id)
    return stats, errors


# --------------------------------------------------------------------------
# Route
# --------------------------------------------------------------------------

@router.post("/tasks")
async def import_tasks(
    file: UploadFile = File(...),
    format: str = Form("auto"),
    notes_as_notes: bool = Form(True),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if format not in VALID_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid format. Must be one of: {', '.join(sorted(VALID_FORMATS))}",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")

    resolved_format = format
    if resolved_format == "auto":
        resolved_format = _detect_format(file.filename or "", content)

    parse = PARSERS.get(resolved_format, _parse_generic)
    rows = await asyncio.to_thread(parse, content)

    if len(rows) > settings.import_max_rows:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This file has {len(rows)} rows, above the "
                f"{settings.import_max_rows}-row limit. Split the file and import in parts."
            ),
        )

    user_id = str(user.id)
    if user_id in _active_imports:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An import is already running for your account. Wait for it to finish before starting another.",
        )
    _active_imports.add(user_id)
    try:
        batch_id = uuid.uuid4()
        stats, errors = await _run_import(
            session, user.id, rows, notes_as_notes, batch_id
        )
    finally:
        _active_imports.discard(user_id)

    return {
        "batch_id": str(batch_id),
        "total_rows": len(rows),
        "imported": stats["imported"],
        "skipped": stats["skipped"],
        "failed": stats["failed"],
        "notes_imported": stats["notes_imported"],
        "errors": errors[:50],
    }


@router.post("/tasks/undo")
async def undo_import(
    payload: UndoImportRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    try:
        batch_id = uuid.UUID(str(payload.batch_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No import batch found to undo",
        )

    ids = set(
        await session.scalars(
            select(Task.id).where(
                Task.user_id == user.id, Task.import_batch_id == batch_id
            )
        )
    )
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No import batch found to undo",
        )

    # Descendant walk: subtasks (checklist children), recurrence occurrences
    # (including ones lazily expanded by background loops after import) all
    # chain through parent_task_id, so undoing the batch removes them too.
    to_delete = set(ids)
    frontier = set(ids)
    while frontier:
        kids = set(
            await session.scalars(
                select(Task.id).where(Task.parent_task_id.in_(frontier))
            )
        )
        new = kids - to_delete
        if not new:
            break
        to_delete |= new
        frontier = new

    deleted_tasks = 0
    if to_delete:
        result = await session.execute(delete(Task).where(Task.id.in_(to_delete)))
        deleted_tasks = result.rowcount or 0

    note_ids = list(
        await session.scalars(
            select(Note.id).where(
                Note.user_id == user.id, Note.import_batch_id == batch_id
            )
        )
    )
    deleted_notes = 0
    if note_ids:
        result = await session.execute(delete(Note).where(Note.id.in_(note_ids)))
        deleted_notes = result.rowcount or 0

    await session.commit()
    return {"deleted_tasks": deleted_tasks, "deleted_notes": deleted_notes}
