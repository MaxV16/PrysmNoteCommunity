"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api";
import { ensureCsrf, getCsrfToken, CSRF_HEADER } from "@/lib/csrf";
import { track } from "@/lib/track";
import { stripTextToolCalls } from "@/lib/ai-format";
import { refreshTasksPreservingWindow } from "@/hooks/useTasks";
import type { ChatMessage, AiSessionListItem } from "@/types/ai";

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

async function doRefreshToken(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function isAbortError(err: unknown): boolean {
  // Aborts surface as DOMException[AbortError] (not instanceof Error) in
  // browsers, and as Error with name AbortError under Node - match on the name.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

// Merges the /tasks/ snapshot (never replaces) and replays the lazy far window,
// so far-window tasks loaded by scroll-driven range fetches stay visible after
// an AI tool turn ("the tasks disappeared" fix).
async function refreshTasksFromServer() {
  try {
    await refreshTasksPreservingWindow();
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
  // Auth is cookie-based (HttpOnly); no Authorization header can be derived
  // from document.cookie, and this runner is intentionally dead code (L2).
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const csrf = getCsrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;

  const fn = toolCall.function;
  // This legacy client-side tool runner is dead code (kept off by design: it
  // lacks ensureCsrf and would 403). Type args loosely so the file compiles.
  let args: any;
  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch {
    return JSON.stringify({ error: "Invalid tool arguments from the model" });
  }

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
      const params = new URLSearchParams();
      if (typeof args.date_from === "string") params.set("date_from", args.date_from);
      if (typeof args.date_to === "string") params.set("date_to", args.date_to);
      const res = await fetch(`${API_URL}/tasks/date-range?${params.toString()}`, {
        headers,
        credentials: "include",
      });
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
  const [backgroundWorking, setBackgroundWorking] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const { chatMessages, addChatMessage, setChatMessages } = useAppStore();
  const sessionIdRef = useRef<string>(getStoredSessionId());
  const abortRef = useRef<AbortController | null>(null);
  const undoStackRef = useRef<Array<{ type: string; data: unknown }>>([]);
  const [hasUndo, setHasUndo] = useState(false);
  const [usageTokens, setUsageTokens] = useState<number | null>(null);
  const backgroundPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadSessionRef = useRef<typeof loadSession>(async () => {});

  const stopBackgroundPoll = useCallback(() => {
    if (backgroundPollRef.current !== null) {
      clearInterval(backgroundPollRef.current);
      backgroundPollRef.current = null;
    }
    setBackgroundWorking(false);
    setTurnPhase(null);
  }, []);

  const startBackgroundPoll = useCallback(() => {
    setBackgroundWorking(true);
    backgroundPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/ai/turn/status`, { credentials: "include" });
        if (!res.ok) {
          stopBackgroundPoll();
          return;
        }
        const data = await res.json();
        if (data.running) {
          setTurnPhase(data.phase);
        } else {
          stopBackgroundPoll();
          if (data.session_id) {
            const sid = getStoredSessionId();
            if (sid) await loadSessionRef.current(sid);
          }
        }
      } catch {
        stopBackgroundPoll();
      }
    }, 2500);
  }, [stopBackgroundPoll]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    // Also cancel server-side background turn
    fetch(`${API_URL}/ai/turn/cancel`, {
      method: "POST", credentials: "include",
    }).catch(() => {});
    stopBackgroundPoll();
  }, [stopBackgroundPoll]);

  const undoLastAction = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    (async () => {
      await ensureCsrf();
      const csrf = getCsrfToken();
      const store = useAppStore.getState();
      if (entry.type === "create_task") {
        const taskId = (entry.data as { id: string }).id;
        try {
          await fetch(`${API_URL}/tasks/${taskId}`, {
            method: "DELETE", credentials: "include",
            headers: csrf ? { [CSRF_HEADER]: csrf } : {},
          });
          store.setTasks(store.tasks.filter((t) => t.id !== taskId));
        } catch {}
      } else if (entry.type === "update_task") {
        const d = entry.data as { id: string; previous: Record<string, unknown> };
        try {
          await fetch(`${API_URL}/tasks/${d.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
            credentials: "include",
            body: JSON.stringify(d.previous),
          });
          store.setTasks(store.tasks.map((t) => (t.id === d.id ? { ...t, ...d.previous } : t)));
        } catch {}
      }
    })();
  }, []);

  const loadSession = useCallback(
    async (sid: string) => {
      sessionIdRef.current = sid;
      setStoredSessionId(sid);
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
  loadSessionRef.current = loadSession;

  // Resume the last conversation on page refresh / AI-panel reopen instead of
  // starting fresh: the backend persists every turn (user AND assistant), so
  // the same chat (with the AI replies) comes back. A first-time visitor (no
  // stored session) or a different account (clearUserData wipes ai_session_id)
  // still starts a brand-new session. Use "New chat" to leave one on purpose.
  useEffect(() => {
    const stored = getStoredSessionId();
    if (stored && stored !== sessionIdRef.current) {
      sessionIdRef.current = stored;
    }
    if (stored) {
      loadSession(stored);
    } else {
      sessionIdRef.current = crypto.randomUUID();
      setStoredSessionId(sessionIdRef.current);
      setChatMessages([]);
    }
    // Check if there's a running background turn for the active session.
    (async () => {
      try {
        const res = await fetch(`${API_URL}/ai/turn/status`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (data.running && data.session_id === getStoredSessionId()) {
            startBackgroundPoll();
          }
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newChat = useCallback(
    async () => {
      stopBackgroundPoll();
      // Start a brand-new session. Prior server sessions (and their history)
      // are left intact so they stay listed in the history panel.
      sessionIdRef.current = crypto.randomUUID();
      setStoredSessionId(sessionIdRef.current);
      setChatMessages([]);
    },
    [setChatMessages]
  );

  const clearActiveSession = useCallback(async () => {
    // Hard-delete the active server session (and, server-side, any durable
    // memory facts extracted from it), then start fresh - mirrors the X on a
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
      // If a background turn is still running, show a note and skip.
      if (backgroundWorking) {
        const store = useAppStore.getState();
        store.addChatMessage({
          id: "bg-working-" + crypto.randomUUID(),
          role: "user",
          content,
          created_at: new Date().toISOString(),
        });
        store.addChatMessage({
          id: "bg-working-reply-" + crypto.randomUUID(),
          role: "assistant",
          content: "Prysm AI is still working on your previous request. Wait a moment, then try again.",
          created_at: new Date().toISOString(),
        });
        return;
      }

      setIsLoading(true);
      setUsageTokens(null);
      // Account change guard: on login/register/logout clearUserData() wipes the
      // stored ai_session_id. If our ref still holds a session but storage no
      // longer does, a different account took over - start a fresh chat session
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
    [addChatMessage, backgroundWorking]
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
      // the final answer renders as its own clean markdown message - never
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

      const removeAssistantPlaceholder = () => {
        // An aborted stream must not leave an empty assistant bubble behind
        // (ChatMessage would render its TypingIndicator forever). Drop it.
        const store = useAppStore.getState();
        store.setChatMessages(
          store.chatMessages.filter((m) => m.id !== assistantId)
        );
      };

      let res: Response;
      try {
        await ensureCsrf();
        const csrf = getCsrfToken();
        const streamHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (csrf) streamHeaders[CSRF_HEADER] = csrf;
        res = await fetch(`${API_URL}/ai/chat/stream`, {
          method: "POST",
          headers: streamHeaders,
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

        // The access token is short-lived (15 min). When it expires, other API
        // calls auto-refresh via the api wrapper, but this raw stream fetch does
        // not - so refresh once and retry rather than surfacing "Not authenticated".
        if (res.status === 409) {
          removeAssistantPlaceholder();
          setAssistant("Prysm AI is still working on your previous request. Wait a moment, then try again.");
          return;
        }
        if (res.status === 401) {
          const refreshed = await doRefreshToken();
          if (refreshed) {
            const retryHeaders: Record<string, string> = { "Content-Type": "application/json" };
            const retryCsrf = getCsrfToken();
            if (retryCsrf) retryHeaders[CSRF_HEADER] = retryCsrf;
            res = await fetch(`${API_URL}/ai/chat/stream`, {
              method: "POST",
              headers: retryHeaders,
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
          }
        }
      } catch (err: unknown) {
        if (isAbortError(err)) {
          removeAssistantPlaceholder();
          return;
        }
        const msg = err instanceof Error ? err.message : "Failed to fetch";
        setAssistant(`Couldn't reach the server (${msg}). Please try again.`);
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
      let errorMessage = "";

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
              if (currentEvent === "error") {
                // The backend surfaces a friendly, actionable provider error (e.g.
                // "out of credits") as an SSE error event instead of a dead stream.
                errorMessage = data;
                receivedToken = true;
                break;
              } else if (currentEvent === "token") {
                receivedToken = true;
                removeToolBubble();
                const store = useAppStore.getState();
                const existing = store.chatMessages.find((m) => m.id === assistantId);
                // Strip literal "[TOOL_CALLS] name {json}" blocks the model may
                // write so raw JSON never flickers into the live reply (the
                // backend also strips before persisting).
                setAssistant(stripTextToolCalls((existing?.content || "") + data));
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
        if (isAbortError(err)) {
          // User hit stop / closed the panel: drop the empty placeholder so the
          // TypingIndicator does not render forever.
          removeAssistantPlaceholder();
        } else if (err instanceof Error) {
          setAssistant("Sorry, I encountered an error while reading the response. Please try again.");
        }
      } finally {
        // The backend may have created, updated, or deleted tasks via tool calls
        // (create_task, reschedule_task, batch_create_tasks). Refresh the task
        // store so the timeline/kanban/calendar/list reflect the changes - even
        // when the stream is aborted/errors mid-answer. With the backend's
        // commit-before-answer fix, tool-created tasks are durable even if the
        // remaining tokens never arrive, so the timeline must still be refreshed.
        await refreshTasksFromServer();
      }

      if (errorMessage) {
        setAssistant(errorMessage);
        return;
      }

      if (!streamOk) return;

      // A completed voice-diary turn counts as a "diary session" for the growth
      // funnel (mic_pressed → trial_started → diary_session ≥3 → subscribed).
      if (context?.voice_diary && receivedToken) {
        track("diary_session");
      }

      if (!receivedToken && !receivedTool) {
        const store = useAppStore.getState();
        const existing = store.chatMessages.find((m) => m.id === assistantId);
        if (existing && !existing.content) {
          setAssistant(
            "Sorry, I couldn't get a response from the AI. This is usually a missing or invalid API key, or an API account that's out of credits. Check your API key in Settings."
          );
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
    backgroundWorking,
    turnPhase,
    abort,
    undoLastAction,
    hasUndo,
    loadSession,
    newChat,
    clearActiveSession,
    fetchSessions,
    usageTokens,
    stopBackgroundPoll,
  };
}
