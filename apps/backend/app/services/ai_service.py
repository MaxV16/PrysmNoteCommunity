from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.base import get_provider
from app.utils.priority import normalize_priority


# Max number of raw past turns injected into the LLM prompt. Durable memory
# (Workstream 6) lets us keep this small so token usage stays bounded.
CONTEXT_MAX_MESSAGES = 12

# Cap on how many search-result tasks we hand the model in one tool result.
TOOL_SEARCH_MAX = 12
# Cap on the serialized length of a single tool result fed back to the model.
TOOL_RESULT_MAX_CHARS = 3000
# Per-memory character cap when injecting the RECALLED MEMORY block, keeping it
# to a bounded token budget (~MEMORY_TOP_K * MEMORY_CAP chars worst case).
MEMORY_CAP = 400


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_tasks",
            "description": "Search tasks by query string and optional date/priority filters",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "search query"},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD optional start date filter"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD optional end date filter"},
                    "priority_min": {"type": "integer", "description": "minimum priority (1-5)"},
                    "priority_max": {"type": "integer", "description": "maximum priority (1-5)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": "Create a new task. IMPORTANT: if the user mentions a date/time or relative day (tomorrow, next Monday, Friday, etc.), resolve it to an exact ISO date using TODAY'S DATE and ALWAYS pass it in start_date (and due_date if relevant). Do not create date-less tasks when the user gave a date. When a specific date is used, first call list_tasks_by_date_range for that date to flag conflicts in your reply (medical/priority-5 tasks outrank regular meetings). TITLE vs DESCRIPTION: keep title SHORT and actionable (a concise noun-phrase, ~6 words max, e.g. \"Buy supplies\"). Put ALL supporting detail, item/vendor specifics, context and times (\"12pm\", \"morning\") into description. NEVER silently drop user detail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "project": {"type": "string", "description": "project name"},
                    "start_date": {"type": "string", "description": "YYYY-MM-DD. REQUIRED whenever the user mentions a date/time."},
                    "due_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                    "recurrence_rule": {"type": "string", "description": "RRULE string"},
                    "description": {"type": "string"},
                    "estimated_minutes": {"type": "integer", "description": "estimated time in minutes"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_task",
            "description": "Update task fields",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "fields": {"type": "object", "description": "fields to update"},
                },
                "required": ["task_id", "fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_task",
            "description": "Delete a task",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_task_details",
            "description": "Get full task details with links, tags, subtasks",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "link_tasks",
            "description": "Link two tasks with a relationship type",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "link_type": {"type": "string", "enum": ["depends_on", "related", "blocks", "duplicates"]},
                },
                "required": ["source_id", "target_id", "link_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_calendar",
            "description": "Check calendar density for a date range",
            "parameters": {
                "type": "object",
                "properties": {
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                },
                "required": ["date_from", "date_to"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_subtasks",
            "description": "Get AI-generated subtask suggestions for a task",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "detect_conflicts",
            "description": "Detect scheduling conflicts for a dated task with priority information. Priority 1 (high/medical/health) always outranks lower-priority tasks. Lower priority numbers are MORE important (1=high, 2=medium, 3=low). Use this to check whether a task clashes with existing higher-priority tasks before finalizing a schedule and to surface clashes in your reply.",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reschedule_task",
            "description": "Reschedule a task to a new date/time with conflict checking",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "new_start_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "new_due_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "reason": {"type": "string", "description": "reason for rescheduling"},
                },
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tasks_by_date_range",
            "description": "List all tasks in a date range with their priorities",
            "parameters": {
                "type": "object",
                "properties": {
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                },
                "required": ["date_from", "date_to"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_best_time",
            "description": "Analyze calendar and suggest the best free time slot for scheduling",
            "parameters": {
                "type": "object",
                "properties": {
                    "desired_date": {"type": "string", "description": "YYYY-MM-DD preferred date"},
                    "duration_hours": {"type": "number", "description": "estimated duration in hours"},
                    "min_priority_to_consider": {"type": "integer", "description": "minimum priority of existing tasks to consider as conflicts (default: 3)"},
                },
                "required": ["desired_date", "duration_hours"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_upcoming_deadlines",
            "description": "Get tasks approaching their due dates, sorted by urgency",
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {"type": "integer", "description": "number of days to look ahead (default: 7)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "batch_create_tasks",
            "description": "Create multiple tasks at once (for compound commands). Keep each title short and actionable (~6 words); put supporting detail and times into that task's description.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "project": {"type": "string"},
                                "start_date": {"type": "string"},
                                "due_date": {"type": "string"},
                                "priority": {"type": "integer"},
                                "description": {"type": "string", "description": "full detail/context/notes for the task"},
                            },
                            "required": ["title"],
                        },
                    },
                },
                "required": ["tasks"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_subtasks",
            "description": "List the subtasks (child tasks) of a task, with status, priority and order",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_subtask",
            "description": "Create a subtask (child task) under a parent task",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["task_id", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_subtask",
            "description": "Update a subtask's title, status or priority",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "subtask_id": {"type": "string"},
                    "fields": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "status": {"type": "string", "enum": ["backlog", "todo", "in_progress", "done", "cancelled"]},
                            "priority": {"type": "integer"},
                        },
                    },
                },
                "required": ["task_id", "subtask_id", "fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_subtask",
            "description": "Delete a subtask (child task) of a parent task",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "subtask_id": {"type": "string"},
                },
                "required": ["task_id", "subtask_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reorder_subtasks",
            "description": "Reorder a task's subtasks by providing the ordered subtask ids",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "ordered_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["task_id", "ordered_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_description_to_subtasks",
            "description": "Split a task's description into subtasks (one per bullet/line), clearing the description",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_subtasks_to_description",
            "description": "Collapse a task's subtasks back into a markdown description, deleting the subtasks",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
]


def build_messages(chat_history: list[dict], user_message: str, context: dict | None = None, summary: str | None = None, memories: list[str] | None = None) -> list[dict]:
    from datetime import date
    today = date.today().isoformat()

    system_content = f"""TODAY'S DATE: {today} (use THIS date as your reference when the user says "today", "tomorrow", "next Monday", "this Friday", etc.).

You are Prysm AI, a hyper-intelligent task management agent. You are the user's personal productivity assistant and schedule optimizer.

CORE BEHAVIOR: When the user gives you a request, follow this protocol:
1. PARSE: Extract task title, date/time, priority, recurrence, project, dependencies.
2. ACT: For scheduling/creation requests, CONFIRM the details (compute exact dates yourself using TODAY'S DATE) then CREATE the task with create_task or batch_create_tasks. DO NOT just describe what you would do — actually do it.
3. VERIFY CONFLICTS: When a request targets a SPECIFIC DATE (the user names a day — "next Monday", "March 3rd", "tomorrow", "Friday"), call list_tasks_by_date_range for that same day BEFORE creating so you know what is already scheduled. High-priority tasks (priority 1 — use for medical/health anything) always outrank a routine meeting (priority 2): if the new dated task would clash with an existing higher-priority task, DO NOT silently double-book — create it anyway but clearly warn the user in your reply with the exact date and the conflicting task's title/priority, or ask which to keep.
4. EXPLAIN: Briefly tell the user what you did (1-2 lines max), and if there was a conflict, explicitly call it out.

DECISION RULES:
- When the user asks to add/schedule/create a task (e.g. "schedule GP appointment next Monday at 12pm", "add a reminder to call mom"), CALL create_task (or batch_create_tasks for several). Only skip creating if you genuinely cannot parse the details — then ask ONE clarifying question.
- If the user's request includes ANY date/time ("next Monday", "tomorrow", "Friday", "at 12pm", "next week"), you MUST compute the exact YYYY-MM-DD from TODAY'S DATE and pass it as start_date. NEVER create a date-less task when a date was given.
- Before creating a task on a SPECIFIC date, call list_tasks_by_date_range for that date to check for conflicts. If a conflict exists and the existing task has higher priority (especially priority 1 = high, which includes medical), mention it and the exact date in your reply.
- "12pm", "morning", "in the afternoon" have no date field; capture them in description and set estimated_minutes if useful.
- TITLE vs DESCRIPTION: keep `title` SHORT and actionable — a concise noun-phrase of about 6 words or fewer (e.g. "Buy supplies"). Put ALL supporting detail — vendor/item specifics, context, the "why", and any times like "12pm"/"morning" — into `description`. NEVER drop user detail: if the user gives specifics, they go in `description`, never silently discarded. Example: "Buy engine oil & supplies for mechanic" → title="Buy supplies", description="For mechanic (engine oil and related supplies)".
- If the user asks "what's coming up / deadlines", use get_upcoming_deadlines and summarize.
- If the user asks to find tasks, use search_tasks.
- If the user asks to move a task, use reschedule_task. If they ask to edit fields, use update_task.
- Never end the turn after doing only read-only searches when the user asked you to CREATE something. Finish the job.

NATURAL LANGUAGE UNDERSTANDING:
- "gp appointment next week monday at 12pm" → next Monday, priority 1 (high/medical)
- "call mom every sunday" → recurring task, priority 2 (medium)
- "finish the report by Friday" → due_date this Friday, priority from context (default 2)
- "maybe learn guitar someday" → backlog status, low priority (3), no dates
- Priority scale is 3 levels: 1=High (red), 2=Medium (blue), 3=Low (green). Lower number = more important. Use 1 for medical/health or anything that must outrank routine meetings; use 2 by default; use 3 for low-priority/ someday items.
- Relative dates across months: calculate correctly from TODAY'S DATE.

ALWAYS:
- Use create_task or batch_create_tasks for anything the user wants added.
- Use reschedule_task when moving tasks, not just update_task.
- When creating or rescheduling a task onto a specific date, check that date for conflicts (list_tasks_by_date_range) and warn the user if the day is already crowded or a higher-priority/medical task is scheduled.
- To view a task's subtasks call get_subtasks; to add/update/delete/reorder them use the matching subtask tools. To rewrite a long description into a checklist use convert_description_to_subtasks; to collapse a checklist back into prose use convert_subtasks_to_description.
- Use get_task_details to inspect any task (with its links, tags and subtasks) before manipulating it.
- Be concise and decisive."""

    if context:
        if context.get("focused_task"):
            task = context["focused_task"]
            system_content += f'\n\nCURRENT FOCUS: The user is viewing task "{task.get("title", "")}"'
            if task.get("description"):
                system_content += f" (description: {task['description'][:200]})"
            if task.get("project_name"):
                system_content += f' in project "{task["project_name"]}"'
            system_content += ". You can help with this specific task."

        if context.get("view_filter"):
            vf = context["view_filter"]
            system_content += f'\n\nCURRENT VIEW: User is filtering by "{vf}".'

        if context.get("calendar_density"):
            cd = context["calendar_density"]
            if isinstance(cd, list):
                busy_days = [d for d in cd if d.get("count", 0) >= 5]
                if busy_days:
                    days_str = ", ".join(d["date"] for d in busy_days[:5])
                    system_content += f"\n\nSCHEDULE ALERT: The following days have 5+ tasks (overcrowded): {days_str}. Be cautious when scheduling on these dates."

    if summary and summary.strip():
        system_content += (
            "\n\nCONTEXT SUMMARY — IMPORTANT LONG-TERM MEMORY:\n"
            "The following is a rolling summary of earlier parts of this conversation that may no longer be "
            "in the raw history. Treat it as ground truth for facts you established earlier "
            "(tasks created, their titles/dates/priorities, decisions, user preferences).\n\n"
            f"{summary.strip()}"
        )

    if memories:
        # Durable cross-session memories surfaced for THIS message. Hard token cap
        # (first N chars) so memory never expands the window unboundedly.
        block = "\n\n".join(m[:MEMORY_CAP] for m in memories)
        if block:
            system_content += (
                "\n\nRECALLED MEMORY — facts the user established in PREVIOUS chats "
                "(durable, cross-session). Weave them into your answer naturally when "
                "they are relevant; do not restate them as a list to the user.\n\n"
                f"{block}"
            )

    messages = [{"role": "system", "content": system_content}]
    messages.extend(chat_history[-CONTEXT_MAX_MESSAGES:])
    messages.append({"role": "user", "content": user_message})
    return messages


async def get_llm_client(provider: str, api_key: str):
    return get_provider(provider, api_key)


async def execute_tool_calls(
    tool_calls: list[dict],
    user_id: str,
    session: AsyncSession,
    client = None,
) -> list[dict]:
    import json
    from datetime import date as _date
    from app.models.task import Task, TaskStatus
    from app.models.project import Project

    # Normalize user_id to a string. The router passes user.id, which SQLAlchemy
    # hands over as a uuid.UUID object; wrapping UUID(uuid.UUID) in the tool
    # handlers crashes with "'UUID' object has no attribute 'replace'".
    user_id = str(user_id)

    def _parse_date_arg(value):
        if value is None or isinstance(value, _date):
            return value
        try:
            return _date.fromisoformat(value)
        except (ValueError, TypeError):
            return None
    from app.services.task_service import create_task, search_tasks, get_task

    results = []

    for tc in tool_calls:
        fn = tc.get("function", {})
        name = fn.get("name", "")
        try:
            args = json.loads(fn.get("arguments", "{}"))
        except json.JSONDecodeError:
            results.append({"tool_call_id": tc.get("id"), "role": "tool", "content": "Invalid arguments"})
            continue

        try:
            if name == "search_tasks":
                query = args.get("query", "")
                date_from = args.get("date_from")
                date_to = args.get("date_to")
                priority_min = args.get("priority_min")
                priority_max = args.get("priority_max")

                from sqlalchemy import or_
                stmt = select(Task).where(
                    Task.user_id == UUID(user_id),
                    or_(
                        Task.title.ilike(func.concat('%', query, '%')),
                        Task.description.ilike(func.concat('%', query, '%')),
                    ),
                )
                if date_from:
                    stmt = stmt.where(Task.start_date >= _parse_date_arg(date_from))
                if date_to:
                    stmt = stmt.where(Task.start_date <= _parse_date_arg(date_to))
                if priority_min is not None:
                    stmt = stmt.where(Task.priority >= priority_min)
                if priority_max is not None:
                    stmt = stmt.where(Task.priority <= priority_max)
                stmt = stmt.limit(TOOL_SEARCH_MAX)

                task_list = await session.execute(stmt)
                tasks = task_list.scalars().all()
                found = [{"id": str(t.id), "title": t.title, "status": t.status.value if t.status else None,
                          "priority": t.priority, "start_date": str(t.start_date) if t.start_date else None,
                          "due_date": str(t.due_date) if t.due_date else None} for t in tasks]
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"found": len(found), "tasks": found}),
                })

            elif name == "create_task":
                title = args.get("title", "Untitled")
                project_name = args.get("project")
                project_id = None

                # Deduplication: check for similar existing tasks
                from sqlalchemy import or_
                similar = await session.execute(
                    select(Task).where(
                        Task.user_id == UUID(user_id),
                        Task.title.ilike(func.concat('%', title[:30], '%')),
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                    ).limit(3)
                )
                similar_tasks = similar.scalars().all()
                if similar_tasks:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "warning": "duplicate_check",
                            "message": f"Found {len(similar_tasks)} similar existing task(s). Created the new task, but you may want to review duplicates.",
                            "similar_tasks": [
                                {"id": str(t.id), "title": t.title, "status": t.status.value}
                                for t in similar_tasks
                            ],
                        }),
                    })
                    # Still create the task - the LLM can decide based on the warning

                if project_name:
                    proj_result = await session.execute(
                        select(Project).where(Project.user_id == UUID(user_id), Project.name == project_name)
                    )
                    proj = proj_result.scalar_one_or_none()
                    if proj:
                        project_id = proj.id
                    else:
                        proj = Project(user_id=UUID(user_id), name=project_name)
                        session.add(proj)
                        await session.flush()
                        project_id = proj.id

                task = await create_task(
                    session,
                    user_id=UUID(user_id),
                    title=title,
                    project_id=project_id,
                    description=args.get("description"),
                    start_date=args.get("start_date"),
                    due_date=args.get("due_date"),
                    priority=args.get("priority", 2),
                    recurrence_rule=args.get("recurrence_rule"),
                )

                # Conflict enrichment: after creating a dated task, surface any
                # overlapping tasks on the same day so the model can warn the user
                # even if it forgot to call list_tasks_by_date_range. Medical/health
                # (priority 5) tasks outrank regular meetings (priority 3).
                conflicts = []
                if task.start_date or task.due_date:
                    from sqlalchemy import or_
                    ts = task.start_date
                    te = task.due_date or task.start_date
                    conflict_result = await session.execute(
                        select(Task).where(
                            Task.user_id == UUID(user_id),
                            Task.id != task.id,
                            Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                            or_(
                                Task.start_date == ts,
                                Task.due_date == te,
                                (Task.start_date <= te) & (Task.due_date >= ts),
                                (Task.start_date <= te) & (Task.due_date.is_(None)),
                                (Task.due_date >= ts) & (Task.start_date.is_(None)),
                            ),
                        ).order_by(Task.priority.asc(), Task.start_date).limit(10)
                    )
                    for ct in conflict_result.scalars().all():
                        ct_prio = normalize_priority(ct.priority)
                        new_prio = normalize_priority(task.priority or 2)
                        # Priority tiers: lower number == more important
                        # (1=high/red incl. medical, 2=medium/blue, 3=low/green).
                        # A conflict task outranks the new task when its tier number
                        # is SMALLER (more important).
                        conflicts.append({
                            "id": str(ct.id),
                            "title": ct.title,
                            "priority": ct.priority,
                            "start_date": str(ct.start_date) if ct.start_date else None,
                            "due_date": str(ct.due_date) if ct.due_date else None,
                            "outranks_new": ct_prio < new_prio,
                        })

                created_payload = {"created": True, "task": {"id": str(task.id), "title": task.title}}
                if conflicts:
                    created_payload["conflict_warning"] = {
                        "conflict_count": len(conflicts),
                        "message": "This task overlaps existing task(s) on the same day. If a conflicting task has HIGHER priority (priority 1 = high, which includes medical/health), you MUST warn the user in your reply with the date and conflicting title(s).",
                        "conflicts": conflicts,
                    }
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps(created_payload),
                })

            elif name == "update_task":
                task_id = args.get("task_id")
                fields = args.get("fields", {})
                result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = result.scalar_one_or_none()
                if task:
                    for key, value in (fields or {}).items():
                        if key in {"title", "description", "status", "priority", "start_date", "due_date"}:
                            if key == "priority":
                                value = normalize_priority(value)
                            setattr(task, key, value)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"updated": True, "task_id": task_id}),
                    })
                else:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })

            elif name == "delete_task":
                task_id = args.get("task_id")
                result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = result.scalar_one_or_none()
                if task:
                    await session.delete(task)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"deleted": True, "task_id": task_id}),
                    })
                else:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })

            elif name == "get_task_details":
                task_id = args.get("task_id")
                result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = result.scalar_one_or_none()
                if task:
                    from app.models.task_tag import TaskTag
                    from app.models.tag import Tag
                    from app.models.task_link import TaskLink
                    tags_result = await session.execute(
                        select(Tag).join(TaskTag).where(TaskTag.task_id == task.id)
                    )
                    tags = [{"id": str(t.id), "name": t.name, "color": t.color} for t in tags_result.scalars().all()]
                    links_result = await session.execute(
                        select(TaskLink).where(
                            (TaskLink.source_task_id == task.id) | (TaskLink.target_task_id == task.id)
                        )
                    )
                    links = [
                        {"id": str(l.id), "source_id": str(l.source_task_id), "target_id": str(l.target_task_id), "link_type": l.link_type.value}
                        for l in links_result.scalars().all()
                    ]
                    subtasks_result = await session.execute(
                        select(Task).where(Task.parent_task_id == task.id)
                    )
                    subtasks = [{"id": str(t.id), "title": t.title, "status": t.status.value} for t in subtasks_result.scalars().all()]
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "id": str(task.id),
                            "title": task.title,
                            "description": task.description,
                            "status": task.status.value if task.status else None,
                            "priority": task.priority,
                            "start_date": str(task.start_date) if task.start_date else None,
                            "due_date": str(task.due_date) if task.due_date else None,
                            "project_id": str(task.project_id) if task.project_id else None,
                            "tags": tags,
                            "links": links,
                            "subtasks": subtasks,
                        }),
                    })
                else:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })

            elif name == "link_tasks":
                from app.models.task_link import TaskLink, TaskLinkType
                source_id = args.get("source_id")
                target_id = args.get("target_id")
                link_type = args.get("link_type", "related")
                source = await session.execute(select(Task).where(Task.id == UUID(source_id)))
                target = await session.execute(select(Task).where(Task.id == UUID(target_id)))
                if not source.scalar_one_or_none() or not target.scalar_one_or_none():
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "One or both tasks not found"}),
                    })
                else:
                    link = TaskLink(
                        user_id=UUID(user_id),
                        source_task_id=UUID(source_id),
                        target_task_id=UUID(target_id),
                        link_type=TaskLinkType(link_type),
                    )
                    session.add(link)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "created": True,
                            "link": {"id": str(link.id), "source_id": source_id, "target_id": target_id, "link_type": link_type},
                        }),
                    })

            elif name == "check_calendar":
                from sqlalchemy import func as sa_func
                date_from = _parse_date_arg(args.get("date_from"))
                date_to = _parse_date_arg(args.get("date_to"))
                count_result = await session.execute(
                    select(
                        Task.start_date,
                        sa_func.count(Task.id),
                    )
                    .where(
                        Task.user_id == UUID(user_id),
                        Task.start_date.isnot(None),
                        Task.start_date >= date_from,
                        Task.start_date <= date_to,
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                    )
                    .group_by(Task.start_date)
                    .order_by(Task.start_date)
                )
                density = []
                for row in count_result:
                    density.append({"date": str(row[0]), "count": row[1]})
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"date_from": str(date_from), "date_to": str(date_to), "density": density}),
                })

            elif name == "suggest_subtasks":
                task_id = args.get("task_id")
                task_result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = task_result.scalar_one_or_none()
                if not task:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                elif not client:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "task_id": task_id,
                            "title": task.title,
                            "suggestions": [
                                "Define scope and requirements",
                                "Break down into smaller steps",
                                "Set milestones and deadlines",
                                "Assign resources",
                                "Track progress and adjust",
                            ],
                        }),
                    })
                else:
                    breakdown_prompt = f"""You are a task breakdown expert. Given a high-level task, suggest 4-6 concrete, actionable subtasks that would help complete it. Each subtask should be specific, achievable, and ordered logically.

Task title: {task.title}
Task description: {task.description or 'None'}

Return exactly a JSON array of strings, nothing else. Example: ["Research and define scope", "Create project timeline", "Assign team roles"]"""

                    try:
                        breakdown_messages = [
                            {"role": "user", "content": breakdown_prompt}
                        ]
                        breakdown_response = await client.chat(
                            breakdown_messages,
                            tools=None,
                            temperature=0.7,
                            max_tokens=500,
                        )
                        breakdown_content = breakdown_response.get("choices", [{}])[0].get("message", {}).get("content", "")
                        try:
                            suggestions = json.loads(breakdown_content)
                            if not isinstance(suggestions, list):
                                suggestions = [s.strip() for s in breakdown_content.split("\n") if s.strip().startswith(("\"", "'", "-", "*", "\\d"))]
                                suggestions = [s.lstrip("-*\\d. \t\"").rstrip("\",") for s in suggestions]
                        except json.JSONDecodeError:
                            suggestions = [s.strip("-*\\d. \t\"").rstrip("\",") for s in breakdown_content.split("\n") if s.strip()]
                            suggestions = [s for s in suggestions if len(s) > 3][:6]
                        if not suggestions:
                            suggestions = [
                                "Define scope and requirements",
                                "Break down into smaller steps",
                                "Set milestones and deadlines",
                                "Assign resources",
                                "Track progress and adjust",
                            ]
                        results.append({
                            "tool_call_id": tc.get("id"),
                            "role": "tool",
                            "content": json.dumps({
                                "task_id": task_id,
                                "title": task.title,
                                "suggestions": suggestions,
                                "source": "ai",
                            }),
                        })
                    except Exception:
                        results.append({
                            "tool_call_id": tc.get("id"),
                            "role": "tool",
                            "content": json.dumps({
                                "task_id": task_id,
                                "title": task.title,
                                "suggestions": [
                                    "Define scope and requirements",
                                    "Break down into smaller steps",
                                    "Set milestones and deadlines",
                                    "Assign resources",
                                    "Track progress and adjust",
                                ],
                                "source": "fallback",
                            }),
                        })

            elif name == "detect_conflicts":
                task_id = args.get("task_id")
                task_result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = task_result.scalar_one_or_none()
                if not task or not task.start_date or not task.due_date:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found or has no date range"}),
                    })
                else:
                    from sqlalchemy import or_

                    overlapping = await session.execute(
                        select(Task)
                        .where(
                            Task.user_id == UUID(user_id),
                            Task.id != UUID(task_id),
                            Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                            or_(
                                (Task.start_date <= task.due_date) & (Task.due_date >= task.start_date),
                                (Task.start_date <= task.due_date) & (Task.due_date.is_(None)),
                                (Task.due_date >= task.start_date) & (Task.start_date.is_(None)),
                            ),
                        )
                        .order_by(Task.priority.asc())
                    )
                    conflicts = overlapping.scalars().all()

                    def compute_resolution(new_priority: int, conflict_tasks: list) -> list:
                        resolutions = []
                        new_tier = normalize_priority(new_priority)
                        for ct in conflict_tasks:
                            ct_tier = normalize_priority(ct.priority)
                            if ct_tier < new_tier:
                                resolutions.append({
                                    "action": "suggest_move_new_task",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Existing task has higher priority ({ct_tier}) than new task ({new_tier})",
                                })
                            elif ct_tier == new_tier:
                                resolutions.append({
                                    "action": "conflict_warning",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Same priority — user should decide",
                                })
                            else:
                                resolutions.append({
                                    "action": "suggest_reschedule",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Lower priority ({ct_tier}) than new task ({new_tier})",
                                })
                        return resolutions

                    resolutions = compute_resolution(task.priority, conflicts)

                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "task_id": task_id,
                            "task_title": task.title,
                            "task_priority": task.priority,
                            "start_date": str(task.start_date),
                            "due_date": str(task.due_date),
                            "conflict_count": len(conflicts),
                            "conflicts": [
                                {
                                    "id": str(t.id),
                                    "title": t.title,
                                    "priority": t.priority,
                                    "start_date": str(t.start_date) if t.start_date else None,
                                    "due_date": str(t.due_date) if t.due_date else None,
                                }
                                for t in conflicts
                            ],
                            "suggested_resolutions": resolutions,
                        }),
                    })

            elif name == "reschedule_task":
                task_id = args.get("task_id")
                new_start = args.get("new_start_date")
                new_due = args.get("new_due_date")
                reason = args.get("reason", "")

                result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = result.scalar_one_or_none()
                if not task:
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    if new_start:
                        task.start_date = _parse_date_arg(new_start)
                    if new_due:
                        task.due_date = _parse_date_arg(new_due)
                    await session.flush()

                    conflict_info = None
                    if task.start_date and task.due_date:
                        from sqlalchemy import or_

                        overlapping = await session.execute(
                            select(Task).where(
                                Task.user_id == UUID(user_id),
                                Task.id != UUID(task_id),
                                Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                                or_(
                                    (Task.start_date <= task.due_date) & (Task.due_date >= task.start_date),
                                ),
                            )
                        )
                        conflicts = overlapping.scalars().all()
                        if conflicts:
                            conflict_info = {
                                "conflict_count": len(conflicts),
                                "conflicts": [{"id": str(t.id), "title": t.title, "priority": t.priority} for t in conflicts[:5]],
                            }

                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "rescheduled": True,
                            "task_id": task_id,
                            "new_start_date": str(task.start_date) if task.start_date else None,
                            "new_due_date": str(task.due_date) if task.due_date else None,
                            "reason": reason,
                            "conflicts": conflict_info,
                        }),
                    })

            elif name == "list_tasks_by_date_range":
                date_from = _parse_date_arg(args.get("date_from"))
                date_to = _parse_date_arg(args.get("date_to"))

                from sqlalchemy import or_

                result = await session.execute(
                    select(Task)
                    .where(
                        Task.user_id == UUID(user_id),
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                        or_(
                            (Task.start_date >= date_from) & (Task.start_date <= date_to),
                            (Task.due_date >= date_from) & (Task.due_date <= date_to),
                            (Task.start_date <= date_from) & (Task.due_date >= date_to),
                        ),
                    )
                    .order_by(Task.start_date)
                )
                tasks = result.scalars().all()
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({
                        "date_from": str(date_from) if date_from else None,
                        "date_to": str(date_to) if date_to else None,
                        "count": len(tasks),
                        "tasks": [
                            {"id": str(t.id), "title": t.title, "priority": t.priority,
                             "status": t.status.value if t.status else None,
                             "start_date": str(t.start_date) if t.start_date else None,
                             "due_date": str(t.due_date) if t.due_date else None}
                            for t in tasks
                        ],
                    }),
                })

            elif name == "suggest_best_time":
                desired_date = _parse_date_arg(args.get("desired_date"))
                duration_hours = args.get("duration_hours", 1)
                min_priority = args.get("min_priority_to_consider", 2)

                # A task counts as a "considered" conflict when its normalized
                # tier is <= the threshold (lower tier number == more important).
                # Default threshold 2 => consider high(1) + medium(2).
                from sqlalchemy import or_
                result = await session.execute(
                    select(Task).where(
                        Task.user_id == UUID(user_id),
                        Task.start_date == desired_date,
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                        or_(*[Task.priority == t for t in [1, 2, 3] if t <= min_priority]),
                    ).order_by(Task.priority.asc())
                )
                day_tasks = result.scalars().all()

                suggestions = []
                if len(day_tasks) <= 3:
                    suggestions.append("morning slot (9am-12pm)")
                    suggestions.append("afternoon slot (1pm-5pm)")
                elif len(day_tasks) <= 5:
                    suggestions.append("early morning (7am-9am)")
                    suggestions.append("late afternoon (4pm-6pm)")
                else:
                    suggestions.append("day is crowded — consider adjacent dates")
                    from datetime import date as dt, timedelta
                    suggestions.append(f"suggest checking {(dt.today() + timedelta(days=1)).isoformat()} instead")

                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({
                        "desired_date": str(desired_date) if desired_date else None,
                        "duration_hours": duration_hours,
                        "tasks_that_day": len(day_tasks),
                        "suggestions": suggestions,
                    }),
                })

            elif name == "get_upcoming_deadlines":
                days_ahead = args.get("days_ahead", 7)
                from datetime import date as dt, timedelta

                today = dt.today()
                end = today + timedelta(days=days_ahead)

                result = await session.execute(
                    select(Task)
                    .where(
                        Task.user_id == UUID(user_id),
                        Task.due_date.isnot(None),
                        Task.due_date >= today,
                        Task.due_date <= end,
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                    )
                    .order_by(Task.due_date, Task.priority.asc())
                )
                tasks = result.scalars().all()
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({
                        "days_ahead": days_ahead,
                        "count": len(tasks),
                        "deadlines": [
                            {"id": str(t.id), "title": t.title, "priority": t.priority,
                             "due_date": str(t.due_date), "status": t.status.value if t.status else None}
                            for t in tasks
                        ],
                    }),
                })

            elif name == "batch_create_tasks":
                batch = args.get("tasks", [])
                created = []
                for t_data in batch:
                    title = t_data.get("title", "Untitled")
                    project_name = t_data.get("project")
                    project_id = None
                    if project_name:
                        proj_result = await session.execute(
                            select(Project).where(Project.user_id == UUID(user_id), Project.name == project_name)
                        )
                        proj = proj_result.scalar_one_or_none()
                        if proj:
                            project_id = proj.id
                        else:
                            proj = Project(user_id=UUID(user_id), name=project_name)
                            session.add(proj)
                            await session.flush()
                            project_id = proj.id

                    task = await create_task(
                        session,
                        user_id=UUID(user_id),
                        title=title,
                        project_id=project_id,
                        description=t_data.get("description"),
                        start_date=t_data.get("start_date"),
                        due_date=t_data.get("due_date"),
                        priority=t_data.get("priority", 2),
                    )
                    created.append({"id": str(task.id), "title": task.title})

                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"created_count": len(created), "tasks": created}),
                })

            elif name == "get_subtasks":
                from app.services import subtask_service
                task_id = args.get("task_id")
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    result = await session.execute(
                        select(Task).where(Task.parent_task_id == parent.id).order_by(Task.sort_order)
                    )
                    subtasks = [
                        {"id": str(t.id), "title": t.title, "status": t.status.value if t.status else None,
                         "priority": t.priority, "sort_order": t.sort_order,
                         "description": t.description}
                        for t in result.scalars().all()
                    ]
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"task_id": task_id, "count": len(subtasks), "subtasks": subtasks}),
                    })

            elif name == "create_subtask":
                from app.services import subtask_service
                task_id = args.get("task_id")
                title = args.get("title")
                description = args.get("description")
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    child = Task(
                        user_id=parent.user_id,
                        parent_task_id=parent.id,
                        title=title,
                        description=description,
                        status=TaskStatus.TODO,
                        priority=parent.priority,
                        sort_order=await subtask_service.next_sort_order(session, parent.id),
                    )
                    session.add(child)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "created": True,
                            "subtask": {"id": str(child.id), "title": child.title, "status": child.status.value},
                        }),
                    })

            elif name == "update_subtask":
                task_id = args.get("task_id")
                subtask_id = args.get("subtask_id")
                fields = args.get("fields", {}) or {}
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                    continue
                result = await session.execute(select(Task).where(Task.id == UUID(subtask_id)))
                child = result.scalar_one_or_none()
                if not child or str(child.parent_task_id) != str(parent.id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Subtask not found"}),
                    })
                else:
                    for key, value in fields.items():
                        if key in {"title", "description", "status", "priority"}:
                            if key == "status":
                                value = TaskStatus(value)
                            if key == "priority":
                                value = normalize_priority(value)
                            setattr(child, key, value)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "updated": True,
                            "subtask": {"id": str(child.id), "title": child.title, "status": child.status.value, "priority": child.priority},
                        }),
                    })

            elif name == "delete_subtask":
                task_id = args.get("task_id")
                subtask_id = args.get("subtask_id")
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                    continue
                result = await session.execute(select(Task).where(Task.id == UUID(subtask_id)))
                child = result.scalar_one_or_none()
                if not child or str(child.parent_task_id) != str(parent.id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Subtask not found"}),
                    })
                else:
                    await session.delete(child)
                    await session.flush()
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"deleted": True, "subtask_id": subtask_id}),
                    })

            elif name == "reorder_subtasks":
                from app.services import subtask_service
                task_id = args.get("task_id")
                ordered_ids = args.get("ordered_ids", [])
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    ordered = await subtask_service.reorder_subtasks(session, parent, [str(i) for i in ordered_ids])
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"reordered": True, "subtasks": ordered}),
                    })

            elif name == "convert_description_to_subtasks":
                from app.services import subtask_service
                task_id = args.get("task_id")
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    created = await subtask_service.convert_description_to_subtasks(session, parent)
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "converted": True,
                            "subtask_count": len(created),
                            "subtasks": [{"id": str(t.id), "title": t.title} for t in created],
                        }),
                    })

            elif name == "convert_subtasks_to_description":
                from app.services import subtask_service
                task_id = args.get("task_id")
                parent = await get_task(session, UUID(task_id))
                if not parent or str(parent.user_id) != str(user_id):
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"error": "Task not found"}),
                    })
                else:
                    description = await subtask_service.convert_subtasks_to_description(session, parent)
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({"converted": True, "description": description}),
                    })

            else:
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"error": f"Unknown tool: {name}"}),
                })

        except Exception as e:
            results.append({
                "tool_call_id": tc.get("id"),
                "role": "tool",
                "content": json.dumps({"error": str(e)}),
            })

    # Bound token usage: don't feed huge serialized tool outputs back to the
    # model. Truncate centrally so every branch is covered.
    for r in results:
        content = r.get("content", "")
        if isinstance(content, str) and len(content) > TOOL_RESULT_MAX_CHARS:
            r["content"] = content[:TOOL_RESULT_MAX_CHARS] + "\n...(truncated)"

    return results

