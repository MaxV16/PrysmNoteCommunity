import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { toLocalDateString } from "@/lib/utils";
import { useInAppReminders } from "./useInAppReminders";

const h = vi.hoisted(() => ({
  prefs: {
    inapp_reminders: true,
    reminder_time: "00:00",
    email_reminders: false,
    due_alerts: true,
    email_digest: false,
    push_enabled: false,
    sound: false,
  },
  loaded: true,
  updateTask: vi.fn().mockResolvedValue(undefined),
  playReminderPing: vi.fn(),
  showSystemNotification: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({
  useNotificationPrefs: () => ({ prefs: h.prefs, loaded: h.loaded }),
  showSystemNotification: h.showSystemNotification,
}));
vi.mock("@/lib/sounds", () => ({ playReminderPing: h.playReminderPing }));
vi.mock("@/hooks/useTasks", () => ({ useTasks: () => ({ updateTask: h.updateTask }) }));
vi.mock("@/lib/api", () => ({ api: { get: h.apiGet } }));

function makeTask(over: Partial<Task>): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    start_time: null,
    end_time: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    reminder_enabled: true,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function farFutureISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
}

describe("useInAppReminders", () => {
  beforeEach(() => {
    localStorage.clear();
    h.loaded = true;
    h.prefs.inapp_reminders = true;
    h.prefs.reminder_time = "00:00";
    h.prefs.sound = false;
    h.updateTask.mockClear();
    h.playReminderPing.mockClear();
    // Default: the bounded server query is unavailable, so existing tests
    // exercise the cached-window fallback. Tests that need the server list
    // override this.
    h.apiGet.mockReset();
    h.apiGet.mockRejectedValue(new Error("offline"));
    useAppStore.setState({ tasks: [], mobileActionTaskId: null });
  });

  it("surfaces tomorrow's and overdue tasks, ignoring future and done ones", async () => {
    useAppStore.setState({
      tasks: [
        makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() }),
        makeTask({ id: "overdue", title: "Overdue task", due_date: "2000-01-01" }),
        makeTask({ id: "future", title: "Future task", due_date: farFutureISO() }),
        makeTask({ id: "done", title: "Done task", due_date: tomorrowISO(), status: "done" }),
        makeTask({ id: "nodate", title: "No date" }),
      ],
    });

    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(2));
    const titles = result.current.reminders.map((r) => r.title).sort();
    expect(titles).toEqual(["Overdue task", "Tomorrow task"]);
  });

  it("ignores tasks that were not opted into reminders", async () => {
    useAppStore.setState({
      tasks: [
        makeTask({ id: "flagged", title: "Flagged task", due_date: tomorrowISO() }),
        makeTask({ id: "plain", title: "Plain task", due_date: tomorrowISO(), reminder_enabled: false }),
      ],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));
    expect(result.current.reminders[0].taskId).toBe("flagged");
  });

  it("fetches a task outside the loaded window when Open is used", async () => {
    useAppStore.setState({ tasks: [], mobileActionTaskId: null });
    const fetched = makeTask({ id: "far", title: "Far away task", due_date: "2000-01-01" });
    h.apiGet.mockResolvedValue(fetched);

    const { result } = renderHook(() => useInAppReminders());
    await act(async () => {
      await result.current.open("far");
    });

    expect(h.apiGet).toHaveBeenCalledWith("/tasks/far");
    expect(useAppStore.getState().tasks.some((t) => t.id === "far")).toBe(true);
    expect(useAppStore.getState().selectedTaskId).toBe("far");
  });

  it("does not re-surface or duplicate tasks already reminded today", async () => {
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });
    const first = renderHook(() => useInAppReminders());
    await waitFor(() => expect(first.result.current.reminders).toHaveLength(1));

    // A second mount the same day must not add the task again.
    const second = renderHook(() => useInAppReminders());
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current.reminders).toHaveLength(0);
  });

  it("plays the ping when sound is on", async () => {
    h.prefs.sound = true;
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));
    expect(h.playReminderPing).toHaveBeenCalledTimes(1);
  });

  it("dismisses and completes a reminder", async () => {
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));

    act(() => result.current.dismiss("tomorrow"));
    expect(result.current.reminders).toHaveLength(0);
  });

  it("orders reminders oldest overdue first", async () => {
    useAppStore.setState({
      tasks: [
        makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() }),
        makeTask({ id: "overdue", title: "Overdue task", due_date: "2000-01-01" }),
      ],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(2));
    expect(result.current.reminders[0].taskId).toBe("overdue");
  });

  it("uses the bounded server list instead of the stale cache", async () => {
    h.apiGet.mockResolvedValue([
      { id: "server", title: "Very old server task", due_date: "2000-01-01", start_date: null },
    ]);
    useAppStore.setState({
      tasks: [makeTask({ id: "cached", title: "Cached task", due_date: tomorrowISO() })],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));
    expect(result.current.reminders[0].taskId).toBe("server");
    expect(h.apiGet).toHaveBeenCalledWith(
      expect.stringContaining("/notifications/reminder-tasks?before=")
    );
  });

  it("prunes stale reminder bookkeeping keys", async () => {
    localStorage.setItem("prysm_reminded_old_2000-01-01", "1");
    localStorage.setItem("prysm_reminder_ran_2000-01-01", "1");
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(0));
    await waitFor(() =>
      expect(localStorage.getItem("prysm_reminded_old_2000-01-01")).toBeNull()
    );
    expect(localStorage.getItem("prysm_reminder_ran_2000-01-01")).toBeNull();
    const todayKey = `prysm_reminder_ran_${toLocalDateString(new Date())}`;
    expect(localStorage.getItem(todayKey)).toBe("1");
  });

  it("marks a task done and clears its reminder", async () => {
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });
    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));

    await act(async () => {
      await result.current.complete("tomorrow");
    });
    expect(h.updateTask).toHaveBeenCalledWith("tomorrow", { status: "done" });
    expect(result.current.reminders).toHaveLength(0);
  });
});

describe("useInAppReminders system notifications", () => {
  beforeEach(() => {
    localStorage.clear();
    h.prefs.push_enabled = false;
    h.showSystemNotification.mockReset();
    h.apiGet.mockReset();
    h.apiGet.mockRejectedValue(new Error("offline"));
    useAppStore.setState({ tasks: [], mobileActionTaskId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers a native desktop notification instead of in-app cards", async () => {
    const showNotification = vi.fn();
    vi.stubGlobal("prysmDesktop", { isDesktop: true, showNotification });
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });

    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(showNotification).toHaveBeenCalled());

    expect(showNotification).toHaveBeenCalledWith({
      title: "Tomorrow task",
      body: "Tomorrow task",
    });
    expect(result.current.reminders).toHaveLength(0);
  });

  it("shows a browser notification when system notifications are enabled", async () => {
    h.prefs.push_enabled = true;
    useAppStore.setState({
      tasks: [makeTask({ id: "tomorrow", title: "Tomorrow task", due_date: tomorrowISO() })],
    });

    const { result } = renderHook(() => useInAppReminders());
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));

    expect(h.showSystemNotification).toHaveBeenCalledWith("Tomorrow task", "Tomorrow task");
  });
});
