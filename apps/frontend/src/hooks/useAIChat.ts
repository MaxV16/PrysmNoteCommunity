"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { streamChat, chat, hasLocalKey, getLocalApiKey } from "@/lib/llm";
import type { ChatMessage } from "@/types/ai";
import type { LLMProvider } from "@/lib/llm";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_tasks",
      description: "Search tasks by query string and optional filters",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "search query" },
          date_from: { type: "string", description: "YYYY-MM-DD optional start date filter" },
          date_to: { type: "string", description: "YYYY-MM-DD optional end date filter" },
          priority_min: { type: "integer", description: "minimum priority filter (1-5)" },
          priority_max: { type: "integer", description: "maximum priority filter (1-5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new task",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          project: { type: "string", description: "project name" },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          due_date: { type: "string", description: "YYYY-MM-DD" },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          recurrence_rule: { type: "string", description: "RRULE string" },
          description: { type: "string" },
          estimated_minutes: { type: "integer", description: "estimated time in minutes" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update task fields",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          fields: { type: "object", description: "fields to update" },
        },
        required: ["task_id", "fields"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_task",
      description: "Reschedule a task to a new date/time with conflict checking",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          new_start_date: { type: "string", description: "YYYY-MM-DD" },
          new_due_date: { type: "string", description: "YYYY-MM-DD" },
          reason: { type: "string", description: "reason for rescheduling" },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks_by_date_range",
      description: "List all tasks in a date range with their priorities",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_deadlines",
      description: "Get tasks approaching their due dates, sorted by urgency",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", description: "number of days to look ahead (default: 7)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_create_tasks",
      description: "Create multiple tasks at once",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                project: { type: "string" },
                start_date: { type: "string" },
                due_date: { type: "string" },
                priority: { type: "integer" },
              },
              required: ["title"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },
];

function getStoredSessionId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ai_session_id") || "";
}

function setStoredSessionId(id: string) {
  localStorage.setItem("ai_session_id", id);
}

function getToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)access_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildFullContext(): string {
  const store = useAppStore.getState();
  const tasks = store.tasks.filter((t) => !t.is_archived);
  const projects = store.projects;
  const tags = store.tags;

  let ctx = "CURRENT DATABASE STATE:\n\n";

  ctx += `Total tasks: ${tasks.length}\n`;
  ctx += `Projects: ${projects.map((p) => p.name).join(", ") || "none"}\n`;
  ctx += `Tags: ${tags.map((t) => t.name).join(", ") || "none"}\n\n`;

  ctx += "TASKS:\n";
  for (const t of tasks.slice(0, 50)) {
    ctx += `- [${t.status}] ${t.title} (priority: ${t.priority})`;
    if (t.start_date) ctx += ` | starts: ${t.start_date}`;
    if (t.due_date) ctx += ` | due: ${t.due_date}`;
    if (t.project_id) {
      const proj = projects.find((p) => p.id === t.project_id);
      if (proj) ctx += ` | project: ${proj.name}`;
    }
    ctx += "\n";
  }

  return ctx;
}

async function executeToolOnBackend(
  toolCall: { function: { name: string; arguments: string } },
  undoStack?: Array<{ type: string; data: unknown }>
): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const fn = toolCall.function;
  const args = JSON.parse(fn.arguments || "{}");

  switch (fn.name) {
    case "search_tasks": {
      const params = new URLSearchParams();
      params.set("q", args.query || "");
      if (args.date_from) params.set("date_from", args.date_from);
      if (args.date_to) params.set("date_to", args.date_to);
      if (args.priority_min) params.set("priority_min", String(args.priority_min));
      if (args.priority_max) params.set("priority_max", String(args.priority_max));
      const res = await fetch(`${API_URL}/tasks/search?${params}`, { headers, credentials: "include" });
      return res.json().then((d) => JSON.stringify(d));
    }
    case "create_task": {
      const body: Record<string, unknown> = { title: args.title };
      if (args.project) body.project_name = args.project;
      if (args.start_date) body.start_date = args.start_date;
      if (args.due_date) body.due_date = args.due_date;
      if (args.priority) body.priority = args.priority;
      if (args.recurrence_rule) body.recurrence_rule = args.recurrence_rule;
      if (args.description) body.description = args.description;
      if (args.estimated_minutes) body.estimated_minutes = args.estimated_minutes;
      const res = await fetch(`${API_URL}/tasks/`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(body),
      });
      const created = await res.json();
      if (undoStack && created.id) {
        undoStack.push({ type: "create_task", data: { id: created.id } });
        if (undoStack.length > 5) undoStack.shift();
      }
      return JSON.stringify(created);
    }
    case "update_task":
    case "reschedule_task": {
      const fields: Record<string, unknown> = {};
      if (args.fields) Object.assign(fields, args.fields);
      if (args.new_start_date) fields.start_date = args.new_start_date;
      if (args.new_due_date) fields.due_date = args.new_due_date;
      if (undoStack) {
        const store = useAppStore.getState();
        const task = store.tasks.find((t) => t.id === args.task_id);
        if (task) {
          const previous: Record<string, unknown> = {};
          for (const key of Object.keys(fields)) {
            (previous as Record<string, unknown>)[key] = (task as Record<string, unknown>)[key];
          }
          undoStack.push({ type: "update_task", data: { id: args.task_id, previous } });
          if (undoStack.length > 5) undoStack.shift();
        }
      }
      const res = await fetch(`${API_URL}/tasks/${args.task_id}`, {
        method: "PATCH",
        headers,
        credentials: "include",
        body: JSON.stringify(fields),
      });
      return res.json().then((d) => JSON.stringify(d));
    }
    case "list_tasks_by_date_range": {
      const res = await fetch(
        `${API_URL}/tasks/date-range?date_from=${args.date_from}&date_to=${args.date_to}`,
        { headers, credentials: "include" }
      );
      return res.json().then((d) => JSON.stringify(d));
    }
    case "get_upcoming_deadlines": {
      const days = args.days_ahead || 7;
      const res = await fetch(`${API_URL}/tasks/upcoming-deadlines?days_ahead=${days}`, {
        headers,
        credentials: "include",
      });
      return res.json().then((d) => JSON.stringify(d));
    }
    case "batch_create_tasks": {
      const res = await fetch(`${API_URL}/tasks/batch`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ tasks: args.tasks || [] }),
      });
      return res.json().then((d) => JSON.stringify(d));
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${fn.name}` });
  }
}

export function useAIChat() {
  const [isLoading, setIsLoading] = useState(false);
  const { chatMessages, addChatMessage, setChatMessages, tasks, projects, tags } = useAppStore();
  const sessionIdRef = useRef<string>(getStoredSessionId());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const undoStackRef = useRef<Array<{ type: string; data: unknown }>>([]);
  const [hasUndo, setHasUndo] = useState(false);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const undoLastAction = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    (async () => {
      const store = useAppStore.getState();
      if (entry.type === "create_task") {
        const taskId = (entry.data as { id: string }).id;
        try {
          await fetch(`${API_URL}/tasks/${taskId}`, { method: "DELETE", credentials: "include" });
          store.setTasks(store.tasks.filter((t) => t.id !== taskId));
        } catch {}
      } else if (entry.type === "update_task") {
        const d = entry.data as { id: string; previous: Record<string, unknown> };
        try {
          await fetch(`${API_URL}/tasks/${d.id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(d.previous),
          });
          store.setTasks(store.tasks.map((t) => (t.id === d.id ? { ...t, ...d.previous } : t)));
        } catch {}
      }
    })();
  }, []);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid || historyLoaded) return;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/ai/conversations/${sid}`, {
          credentials: "include",
        });
        if (res.ok) {
          const history = await res.json();
          if (history.length > 0) {
            const msgs: ChatMessage[] = history.map((h: { role: string; content: string; created_at: string }) => ({
              id: crypto.randomUUID(),
              role: h.role,
              content: h.content,
              created_at: h.created_at,
            }));
            setChatMessages(msgs);
          }
        }
      } catch {
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, [historyLoaded, setChatMessages]);

  const sendMessage = useCallback(
    async (content: string, provider = "openai", context?: Record<string, unknown>) => {
      setIsLoading(true);
      if (!sessionIdRef.current) {
        sessionIdRef.current = crypto.randomUUID();
        setStoredSessionId(sessionIdRef.current);
      }
      const sessionId = sessionIdRef.current;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      addChatMessage(userMsg);

      const assistantId = crypto.randomUUID();
      addChatMessage({
        id: assistantId,
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
      });

      const providerKey = provider as "openai" | "gemini" | "deepseek";
      const useDirectLLM = await hasLocalKey(providerKey);

      if (useDirectLLM) {
        abortRef.current = new AbortController();
        await sendViaDirectLLM(content, providerKey, sessionId, assistantId, context);
      } else {
        abortRef.current = new AbortController();
        await sendViaBackend(content, provider, sessionId, assistantId, context);
      }

      setIsLoading(false);
      abortRef.current = null;
    },
    [addChatMessage, tasks, projects, tags]
  );
  const updateAssistant = (assistantId: string, text: string) => {
    const store = useAppStore.getState();
    store.setChatMessages(
      store.chatMessages.map((m) =>
        m.id === assistantId ? { ...m, content: text } : m
      )
    );
  };

  const sendViaDirectLLM = async (
    content: string,
    provider: "openai" | "gemini" | "deepseek",
    _sessionId: string,
    assistantId: string,
    _context?: Record<string, unknown>
  ) => {
    try {
      const systemPrompt = `You are Prysm AI, a hyper-intelligent task management agent. You think like an expert productivity coach + personal assistant + schedule optimizer combined.

CORE BEHAVIOR: When the user gives you a request, follow this protocol:
1. PARSE: Extract task title, date/time, priority, recurrence, project, dependencies
2. SEARCH: Always search for similar tasks and schedule conflicts before creating
3. ANALYZE: Check calendar density for the target date range
4. CREATE/SUGGEST: Create the task, or if conflicts exist, suggest resolution
5. EXPLAIN: Briefly explain your decisions (1-2 lines max)

NATURAL LANGUAGE UNDERSTANDING:
- "gp appointment next week monday at 12" → parse to next Monday, 12:00, priority assessment
- "call mom every sunday" → recurring task, no end date
- "finish the report by Friday" → due_date this Friday, priority inferred from deadline proximity
- "maybe learn guitar someday" → backlog/someday status, low priority

PRIORITY-BASED CONFLICT RESOLUTION:
- When a new task conflicts with existing tasks on the same day, compare priorities
- If new task has higher priority, suggest rescheduling lower-priority conflicts
- If same priority, suggest time slots or adjacent days
- A day with 5+ tasks triggers an automatic overload warning
- Medical/health appointments default to priority 5 (highest)

EDGE CASES & IRREGULAR SCENARIOS:
- "I need this done yesterday" → set to today with highest priority, warn about being overdue
- "Whenever you get a chance" → inbox/backlog, priority 1
- "ASAP but before my holiday starts on the 20th" → due_date = 19th, high priority
- "Same time as my standup" → search for daily standup task, extract its time
- Multi-task creation: "I need: buy groceries, pick up dry cleaning, call dentist" → create 3 tasks
- Vague deadlines: "around next week" → suggest Wednesday of next week, ask confirmation
- Double-booked but both urgent → flag both, ask user to choose
- Task with no clear action: "think about career change" → create as low-priority backlog with note
- Time-of-day specificity: "tomorrow morning" → start 9am, "tomorrow evening" → start 6pm
- Relative dates across months: "end of next month" → calculate correctly
- Overlapping multi-day tasks: detect and warn

${buildFullContext()}`;

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
        ...chatMessages.slice(-10).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        { role: "user", content },
      ];

      const response = await chat(provider, messages as Array<{ role: string; content: string }>, TOOL_DEFINITIONS, abortRef.current?.signal);

      if (response.tool_calls && response.tool_calls.length > 0) {
        const toolNames = response.tool_calls.map((tc: { function: { name: string } }) => tc.function.name).join(", ");
        updateAssistant(assistantId, `[Running: ${toolNames}]`);

        const toolResults: Array<{ role: string; content: string }> = [];
        for (const tc of response.tool_calls) {
          const result = await executeToolOnBackend(tc, undoStackRef.current);
          toolResults.push({ role: "tool", content: result });
        }
        setHasUndo(undoStackRef.current.length > 0);

        messages.push({ role: "assistant", content: response.content || "" });
        messages.push(...toolResults);

        const body = new ReadableStream({
          async start(controller) {
            try {
              const stream = await streamChat(provider, messages, TOOL_DEFINITIONS, abortRef.current?.signal);
              const reader = stream.getReader();
              const decoder = new TextDecoder();
              let streamBuf = "";
              let fullContent = "";

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                streamBuf += decoder.decode(value, { stream: true });

                const lines = streamBuf.split("\n");
                streamBuf = lines.pop() || "";

                for (const line of lines) {
                  if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                      const chunk = JSON.parse(line.slice(6));
                      const delta = chunk.choices?.[0]?.delta?.content || "";
                      if (delta) {
                        fullContent += delta;
                        updateAssistant(assistantId, `[Running: ${toolNames}]\n\n${fullContent}`);
                      }
                    } catch {
                      continue;
                    }
                  }
                }
              }

              if (!fullContent) {
                const store = useAppStore.getState();
                store.setChatMessages(
                  store.chatMessages.map((m) =>
                    m.id === assistantId ? { ...m, content: response.content || "" } : m
                  )
                );
              }

              controller.close();
            } catch {
              controller.close();
            }
          },
        });

        await body.getReader().read();
      } else {
        const body = new ReadableStream({
          async start(controller) {
            try {
              const stream = await streamChat(provider, messages, TOOL_DEFINITIONS, abortRef.current?.signal);
              const reader = stream.getReader();
              const decoder = new TextDecoder();
              let streamBuf = "";
              let fullContent = "";

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                streamBuf += decoder.decode(value, { stream: true });

                const lines = streamBuf.split("\n");
                streamBuf = lines.pop() || "";

                for (const line of lines) {
                  if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                      const chunk = JSON.parse(line.slice(6));
                      const delta = chunk.choices?.[0]?.delta?.content || "";
                      if (delta) {
                        fullContent += delta;
                        updateAssistant(assistantId, fullContent);
                      }
                    } catch {
                      continue;
                    }
                  }
                }
              }

              if (!fullContent) {
                updateAssistant(assistantId, response.content || "");
              }

              controller.close();
            } catch {
              controller.close();
            }
          },
        });

        await body.getReader().read();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "An error occurred";
      updateAssistant(assistantId, `Error: ${errorMsg}. Please check your API key in Settings.`);
    }
  };

  const sendViaBackend = async (
    content: string,
    provider: string,
    sessionId: string,
    assistantId: string,
    context?: Record<string, unknown>
  ) => {
    try {
      const res = await fetch(`${API_URL}/ai/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: content,
          chat_history: chatMessages.slice(-10),
          session_id: sessionId,
          provider,
          ...(context ? { context } : {}),
        }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent === "token") {
            const store = useAppStore.getState();
            const existing = store.chatMessages.find((m) => m.id === assistantId);
            const newContent = (existing?.content || "") + line.slice(6);
            updateAssistant(assistantId, newContent);
          } else if (line.startsWith("data: ") && currentEvent === "tool_start") {
            updateAssistant(assistantId, "[Tool calls: " + line.slice(6) + "]");
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }
    } catch {
      const store = useAppStore.getState();
      const existing = store.chatMessages.find((m) => m.id === assistantId);
      if (existing && !existing.content) {
        store.setChatMessages(
          store.chatMessages.map((m) =>
            m.id === assistantId
              ? { ...m, content: "Sorry, I encountered an error. Please check your API key." }
              : m
          )
        );
      }
    }
  };

  return { chatMessages, sendMessage, isLoading, abort, undoLastAction, hasUndo };
}
