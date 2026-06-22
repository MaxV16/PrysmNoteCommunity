from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.base import get_provider

BASE_SYSTEM_PROMPT = """You are Prysm AI, an intelligent task management assistant integrated into Prysm Note.
You have full read/write access to the user's complete task database via function calling.

CAPABILITIES:
- Create, read, update, delete tasks and projects
- Search tasks semantically and by keywords
- Link tasks across projects (use link_tasks tool)
- Detect scheduling conflicts with detect_conflicts tool
- Suggest subtasks with suggest_subtasks tool
- Check calendar density with check_calendar tool
- Understand natural language time expressions ("next Thursday", "every 2 weeks")
- Break down complex projects into actionable subtasks

RULES:
1. ALWAYS use search_tasks before creating a new task to check for duplicates.
2. If you find a potential duplicate, tell the user and ask how to proceed.
3. When creating multiple tasks or scheduling on a busy day, run detect_conflicts afterward.
4. For ambiguous intents ("starting a business"), ask clarifying questions.
5. When a task is broad enough ("start a business", "plan a trip"), suggest subtasks.
6. For recurring tasks ("every 2 weeks"), use recurrence_rule with RRULE format.
7. When creating a task with no date specified, set it to "Inbox" status (no dates).
8. A day with 5 or more active tasks is overcrowded — warn before adding more to that day."""

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_tasks",
            "description": "Search tasks by query string and optional filters",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "search query"},
                    "filters": {"type": "object", "description": "optional status/project filters"},
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
            "description": "Detect scheduling conflicts for a task",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
    },
]


def build_messages(chat_history: list[dict], user_message: str, context: dict | None = None) -> list[dict]:
    system_content = BASE_SYSTEM_PROMPT

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
    messages.extend(chat_history)
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
    from app.models.task import Task, TaskStatus
    from app.models.project import Project
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
                task_list = await search_tasks(session, UUID(user_id), query, limit=10)
                found = [{"id": str(t.id), "title": t.title, "status": t.status.value if t.status else None} for t in task_list]
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
                date_from = args.get("date_from")
                date_to = args.get("date_to")
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
                    "content": json.dumps({"date_from": date_from, "date_to": date_to, "density": density}),
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
                    results.append({
                        "tool_call_id": tc.get("id"),
                        "role": "tool",
                        "content": json.dumps({
                            "task_id": task_id,
                            "task_title": task.title,
                            "start_date": str(task.start_date),
                            "due_date": str(task.due_date),
                            "conflict_count": len(conflicts),
                            "conflicts": [
                                {
                                    "id": str(t.id),
                                    "title": t.title,
                                    "start_date": str(t.start_date) if t.start_date else None,
                                    "due_date": str(t.due_date) if t.due_date else None,
                                }
                                for t in conflicts
                            ],
                        }),
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

