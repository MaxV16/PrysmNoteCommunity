from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.base import get_provider


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
            "description": "Create a new task",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "project": {"type": "string", "description": "project name"},
                    "start_date": {"type": "string", "description": "YYYY-MM-DD"},
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
            "description": "Detect scheduling conflicts for a task with priority information",
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
            "description": "Create multiple tasks at once (for compound commands)",
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
                            },
                            "required": ["title"],
                        },
                    },
                },
                "required": ["tasks"],
            },
        },
    },
]


def build_messages(chat_history: list[dict], user_message: str, context: dict | None = None) -> list[dict]:
    from datetime import date
    today = date.today().isoformat()

    system_content = f"""TODAY'S DATE: {today} (use THIS date as your reference when the user says "today", "tomorrow", "next Monday", "this Friday", etc.).

You are Prysm AI, a hyper-intelligent task management agent. You are the user's personal productivity assistant and schedule optimizer.

CORE BEHAVIOR: When the user gives you a request, follow this protocol:
1. PARSE: Extract task title, date/time, priority, recurrence, project, dependencies.
2. ACT: For scheduling/creation requests, CONFIRM the details (compute exact dates yourself using TODAY'S DATE) then CREATE the task with create_task or batch_create_tasks. DO NOT just describe what you would do — actually do it.
3. VERIFY: Only use search_tasks / list_tasks_by_date_range / check_calendar for genuine conflict-checking when it matters (e.g. "is my Tuesday free?"). You already know the date math; do not browse the calendar for a simple "create X on Y" request.
4. EXPLAIN: Briefly tell the user what you did (1-2 lines max).

DECISION RULES:
- When the user asks to add/schedule/create a task (e.g. "schedule GP appointment next Monday at 12pm", "add a reminder to call mom"), CALL create_task (or batch_create_tasks for several). Only skip creating if you genuinely cannot parse the details — then ask ONE clarifying question.
- "12pm", "morning", "in the afternoon" have no time field; capture them in description and set estimated_minutes if useful.
- If the user asks "what's coming up / deadlines", use get_upcoming_deadlines and summarize.
- If the user asks to find tasks, use search_tasks.
- If the user asks to move a task, use reschedule_task. If they ask to edit fields, use update_task.
- Never end the turn after doing only read-only searches when the user asked you to CREATE something. Finish the job.

NATURAL LANGUAGE UNDERSTANDING:
- "gp appointment next week monday at 12pm" → next Monday, priority 5 (medical)
- "call mom every sunday" → recurring task, priority 3
- "finish the report by Friday" → due_date this Friday, priority from context
- "maybe learn guitar someday" → backlog status, low priority, no dates
- Relative dates across months: calculate correctly from TODAY'S DATE.

ALWAYS:
- Use create_task or batch_create_tasks for anything the user wants added.
- Use reschedule_task when moving tasks, not just update_task.
- Only check calendar/conflicts when the user explicitly asks about scheduling conflicts or free time.
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

    messages = [{"role": "system", "content": system_content}]
    messages.extend(chat_history[-20:])
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

    def _parse_date_arg(value):
        if value is None or isinstance(value, _date):
            return value
        try:
            return _date.fromisoformat(value)
        except (ValueError, TypeError):
            return None
    from app.services.task_service import create_task, search_tasks

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
                stmt = stmt.limit(20)

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
                    start_date=args.get("start_date"),
                    due_date=args.get("due_date"),
                    priority=args.get("priority", 3),
                    recurrence_rule=args.get("recurrence_rule"),
                )
                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"created": True, "task": {"id": str(task.id), "title": task.title}}),
                })

            elif name == "update_task":
                task_id = args.get("task_id")
                fields = args.get("fields", {})
                result = await session.execute(select(Task).where(Task.id == UUID(task_id)))
                task = result.scalar_one_or_none()
                if task:
                    for key, value in (fields or {}).items():
                        if key in {"title", "description", "status", "priority", "start_date", "due_date"}:
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
                        .order_by(Task.start_date)
                    )
                    conflicts = overlapping.scalars().all()

                    def compute_resolution(new_priority: int, conflict_tasks: list) -> list:
                        resolutions = []
                        for ct in conflict_tasks:
                            if ct.priority < new_priority:
                                resolutions.append({
                                    "action": "suggest_reschedule",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Lower priority ({ct.priority}) than new task ({new_priority})",
                                })
                            elif ct.priority == new_priority:
                                resolutions.append({
                                    "action": "conflict_warning",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Same priority — user should decide",
                                })
                            else:
                                resolutions.append({
                                    "action": "suggest_move_new_task",
                                    "task_id": str(ct.id),
                                    "task_title": ct.title,
                                    "reason": f"Existing task has higher priority ({ct.priority})",
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
                desired_date = args.get("desired_date")
                duration_hours = args.get("duration_hours", 1)
                min_priority = args.get("min_priority_to_consider", 3)

                result = await session.execute(
                    select(Task).where(
                        Task.user_id == UUID(user_id),
                        Task.start_date == desired_date,
                        Task.status.notin_([TaskStatus.DONE, TaskStatus.CANCELLED]),
                        Task.priority >= min_priority,
                    ).order_by(Task.priority.desc())
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
                        "desired_date": desired_date,
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
                    .order_by(Task.due_date, Task.priority.desc())
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
                        start_date=t_data.get("start_date"),
                        due_date=t_data.get("due_date"),
                        priority=t_data.get("priority", 3),
                    )
                    created.append({"id": str(task.id), "title": task.title})

                results.append({
                    "tool_call_id": tc.get("id"),
                    "role": "tool",
                    "content": json.dumps({"created_count": len(created), "tasks": created}),
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

    return results

