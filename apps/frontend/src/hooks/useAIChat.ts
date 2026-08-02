"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api";
import type { ChatMessage, AiSessionListItem } from "@/types/ai";
import type { Task } from "@/types/task";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

// Upper bound on raw chat history sent to the backend for context. Durable
// memory (server-side) carries older context, so we keep this small.
const CONTEXT_MAX_MESSAGES = 12;

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

async function refreshTasksFromServer() {
  try {
    const data = await api.get<Task[]>("/tasks/");
    useAppStore.getState().setTasks(data);
  } catch {
    // Non-fatal: the next fetch/refresh will retry the server.
  }
}

const TOOL_LABELS: Record<string, string> = {
  create_task: "Creating task",
  batch_create_tasks: "Creating tasks",
  update_task: "Updating task",
  reschedule_task: "Rescheduling task",
  delete_task: "Removing task",
  search_tasks: "Searching tasks",
  list_tasks_by_date_range: "Checking calendar",
  check_calendar: "Checking calendar",
  suggest_best_time: "Finding a free slot",
  detect_conflicts: "Checking for conflicts",
  get_upcoming_deadlines: "Checking upcoming deadlines",
  get_task_details: "Loading task details",
  link_tasks: "Linking tasks",
  suggest_subtasks: "Suggesting subtasks",
  get_subtasks: "Reading subtasks",
  create_subtask: "Adding subtask",
  update_subtask: "Updating subtask",
  delete_subtask: "Removing subtask",
  reorder_subtasks: "Reordering subtasks",
  convert_description_to_subtasks: "Splitting description into subtasks",
  convert_subtasks_to_description: "Collapsing subtasks into description",
};

function prettyToolName(name: string): string {
  return TOOL_LABELS[name] || `Calling ${name}`;
}

function buildFullContext(): string {
  const store = useAppStore.getState();
  const tasks = store.tasks.filter((t) => !t.is_archived);
  const tags = store.tags;

  let ctx = "CURRENT DATABASE STATE:\n\n";

  ctx += `Total tasks: ${tasks.length}\n`;
  ctx += `Tags: ${tags.map((t) => t.name).join(", ") || "none"}\n\n`;

  ctx += "TASKS:\n";
  for (const t of tasks.slice(0, 50)) {
    ctx += `- [${t.status}] ${t.title} (priority: ${t.priority})`;
    if (t.start_date) ctx += ` | starts: ${t.start_date}`;
    if (t.due_date) ctx += ` | due: ${t.due_date}`;
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
            (previous as Record<string, unknown>)[key] = (task as unknown as Record<string, unknown>)[key];
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
  const { chatMessages, addChatMessage, setChatMessages } = useAppStore();
  const sessionIdRef = useRef<string>(getStoredSessionId());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const undoStackRef = useRef<Array<{ type: string; data: unknown }>>([]);
  const [hasUndo, setHasUndo] = useState(false);
  const [usageTokens, setUsageTokens] = useState<number | null>(null);

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

  const loadSession = useCallback(
    async (sid: string) => {
      sessionIdRef.current = sid;
      setStoredSessionId(sid);
      setHistoryLoaded(true);
      try {
        const res = await fetch(`${API_URL}/ai/conversations/${sid}`, { credentials: "include" });
        if (res.ok) {
          const history = await res.json();
          const msgs: ChatMessage[] = history.map((h: { role: string; content: string; created_at: string }) => ({
            id: crypto.randomUUID(),
            role: h.role,
            content: h.content,
            created_at: h.created_at,
          }));
          setChatMessages(msgs);
        } else {
          setChatMessages([]);
        }
      } catch {
        setChatMessages([]);
      }
    },
    [setChatMessages]
  );

  const newChat = useCallback(
    async () => {
      // Start a brand-new session. Prior server sessions (and their history)
      // are left intact so they stay listed in the history panel.
      sessionIdRef.current = crypto.randomUUID();
      setStoredSessionId(sessionIdRef.current);
      setHistoryLoaded(true);
      setChatMessages([]);
    },
    [setChatMessages]
  );

  const clearActiveSession = useCallback(async () => {
    // Hard-delete the active server session (and, server-side, any durable
    // memory facts extracted from it), then start fresh — mirrors the X on a
    // history row. No orphan rows or dangling "life" facts are left behind.
    const prevSid = sessionIdRef.current;
    if (prevSid) {
      try {
        await api.delete(`/ai/sessions/${prevSid}`);
      } catch {
        // Non-fatal: if the session wasn't persisted, start fresh anyway.
      }
    }
    sessionIdRef.current = crypto.randomUUID();
    setStoredSessionId(sessionIdRef.current);
    setHistoryLoaded(true);
    setChatMessages([]);
  }, [setChatMessages]);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await api.get<AiSessionListItem[]>("/ai/sessions");
      return data;
    } catch {
      return [];
    }
  }, []);

  const sendViaBackendRef = useRef<
    (content: string, provider: string, sessionId: string, assistantId: string, context?: Record<string, unknown>, signal?: AbortSignal) => Promise<void>
  >(async () => {});

  const sendMessage = useCallback(
    async (content: string, provider = "openai", context?: Record<string, unknown>) => {
      setIsLoading(true);
      setUsageTokens(null);
      // Account change guard: on login/register/logout clearUserData() wipes the
      // stored ai_session_id. If our ref still holds a session but storage no
      // longer does, a different account took over — start a fresh chat session
      // so we never resume a previous account's conversation.
      const storedNow = getStoredSessionId();
      if (sessionIdRef.current && storedNow !== sessionIdRef.current) {
        sessionIdRef.current = "";
      }
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

      abortRef.current = new AbortController();
      try {
        await sendViaBackendRef.current(content, provider, sessionId, assistantId, context, abortRef.current?.signal);
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [addChatMessage]
  );
  const sendViaBackend = useCallback(
    async (
      content: string,
      provider: string,
      sessionId: string,
      assistantId: string,
      context?: Record<string, unknown>,
      signal?: AbortSignal
    ) => {
      const setAssistant = (text: string) => {
        const store = useAppStore.getState();
        store.setChatMessages(
          store.chatMessages.map((m) =>
            m.id === assistantId ? { ...m, content: text } : m
          )
        );
      };

      // Track a transient "tool activity" bubble (role: "tool") shown while the
      // backend is executing tools. Once the first token arrives we drop it so
      // the final answer renders as its own clean markdown message — never
      // prefixed with "⚙" (which used to hijack ChatMessage into a pill).
      let toolBubbleId: string | null = null;
      const addToolBubble = (label: string) => {
        const store = useAppStore.getState();
        if (toolBubbleId) {
          store.setChatMessages(
            store.chatMessages.map((m) =>
              m.id === toolBubbleId ? { ...m, content: label } : m
            )
          );
          return;
        }
        toolBubbleId = crypto.randomUUID();
        store.setChatMessages([
          ...store.chatMessages,
          {
            id: toolBubbleId,
            role: "tool",
            content: label,
            created_at: new Date().toISOString(),
          },
        ]);
      };
      const removeToolBubble = () => {
        if (!toolBubbleId) return;
        const store = useAppStore.getState();
        store.setChatMessages(store.chatMessages.filter((m) => m.id !== toolBubbleId));
        toolBubbleId = null;
      };

      let res: Response;
      try {
        res = await fetch(`${API_URL}/ai/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal,
          body: JSON.stringify({
            message: content,
            chat_history: chatMessages.slice(-CONTEXT_MAX_MESSAGES),
            session_id: sessionId,
            provider,
            ...(context ? { context } : {}),
          }),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error && err.name !== "AbortError" ? err.message : "Failed to fetch";
        setAssistant(`Error: ${msg}. Please check your API key in Settings.`);
        return;
      }

      if (!res.ok) {
        let message = `Server error ${res.status}`;
        try {
          const body = await res.json();
          if (typeof body?.detail === "string") message = body.detail;
          else if (Array.isArray(body?.detail) && body.detail[0]?.msg) message = body.detail[0].msg;
        } catch {
          message = res.statusText || message;
        }
        setAssistant(`Error: ${message}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setAssistant("Error: No response stream.");
        return;
      }

      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "";
      let receivedToken = false;
      let receivedTool = false;

      let streamOk = true;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (currentEvent === "token") {
                receivedToken = true;
                removeToolBubble();
                const store = useAppStore.getState();
                const existing = store.chatMessages.find((m) => m.id === assistantId);
                setAssistant((existing?.content || "") + data);
              } else if (currentEvent === "tool_start") {
                receivedTool = true;
                const names = (() => {
                  try {
                    const raw = JSON.parse(data);
                    if (Array.isArray(raw)) return raw;
                  } catch {}
                  return [];
                })();
                const label = names.length
                  ? names.map(prettyToolName).join(" · ")
                  : "using tools…";
                addToolBubble(label);
              } else if (currentEvent === "usage") {
                try {
                  const u = JSON.parse(data);
                  if (typeof u?.estimated_tokens === "number") {
                    setUsageTokens(u.estimated_tokens);
                  }
                } catch {
                  // Non-fatal: usage is informational only.
                }
              }
            } else if (line === "") {
              currentEvent = "";
            }
          }
        }
      } catch (err: unknown) {
        streamOk = false;
        if (err instanceof Error && err.name !== "AbortError") {
          setAssistant("Sorry, I encountered an error while reading the response. Please try again.");
        }
      } finally {
        // The backend may have created, updated, or deleted tasks via tool calls
        // (create_task, reschedule_task, batch_create_tasks). Refresh the task
        // store so the timeline/kanban/calendar/list reflect the changes — even
        // when the stream is aborted/errors mid-answer. With the backend's
        // commit-before-answer fix, tool-created tasks are durable even if the
        // remaining tokens never arrive, so the timeline must still be refreshed.
        await refreshTasksFromServer();
      }

      if (!streamOk) return;

      if (!receivedToken && !receivedTool) {
        const store = useAppStore.getState();
        const existing = store.chatMessages.find((m) => m.id === assistantId);
        if (existing && !existing.content) {
          setAssistant("Sorry, I encountered an error. Please check your API key in Settings.");
        }
      }
    },
    [chatMessages]
  );
  sendViaBackendRef.current = sendViaBackend;

  return {
    chatMessages,
    sendMessage,
    isLoading,
    abort,
    undoLastAction,
    hasUndo,
    loadSession,
    newChat,
    clearActiveSession,
    fetchSessions,
    usageTokens,
  };
}
