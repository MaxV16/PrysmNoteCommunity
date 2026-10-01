"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useNotificationPrefs, showSystemNotification } from "@/lib/notifications";
import { getDesktopBridge, openDesktopNotification } from "@/lib/desktop-bridge";
import { playReminderPing } from "@/lib/sounds";
import { api } from "@/lib/api";
import { toLocalDateString } from "@/lib/utils";
import type { Task } from "@/types/task";
import { FOREGROUND_REFRESH_EVENT } from "@/hooks/useForegroundRefresh";

export interface InAppReminder {
  taskId: string;
  title: string;
  dueDate: string;
}

interface ReminderCandidate {
  id: string;
  title: string;
  date: string;
}

interface ReminderTaskRow {
  id: string;
  title: string;
  due_date: string | null;
  start_date: string | null;
}

const CHECK_INTERVAL = 60_000;
const SNOOZE_MS = 60 * 60 * 1000;
const RAN_PREFIX = "prysm_reminder_ran_";
const REMINDED_PREFIX = "prysm_reminded_";
// Hard cap on reminder cards shown at once: an unbounded stack of overdue tasks
// used to cover the whole screen. Overflow is surfaced as a single "+N more".
export const REMINDER_CAP = 5;
// Storage hygiene: keep only today's "reminded" keys and a few days of run
// markers, so the localStorage footprint cannot grow forever.
const PRUNE_AFTER_DAYS = 3;
const PRUNE_SCAN_LIMIT = 500;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage full: reminders still show for this session */
  }
}

/** Tomorrow's local date as YYYY-MM-DD. */
function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toLocalDateString(d);
}

function isDoneOrCancelled(status: string): boolean {
  return status === "done" || status === "cancelled";
}

function byDateThenTitle(a: InAppReminder, b: InAppReminder): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * Remove stale reminder bookkeeping keys. Bounded scan (never walks an unbounded
 * key space) and best-effort: storage errors are ignored.
 */
function pruneStorage(today: string) {
  try {
    const cutoff = toLocalDateString(
      new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000)
    );
    const doomed: string[] = [];
    const total = Math.min(localStorage.length, PRUNE_SCAN_LIMIT);
    for (let i = 0; i < total; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(REMINDED_PREFIX)) {
        const suffix = key.slice(REMINDED_PREFIX.length);
        const datePart = suffix.slice(suffix.lastIndexOf("_") + 1);
        if (DATE_ONLY.test(datePart) && datePart !== today) doomed.push(key);
      } else if (key.startsWith(RAN_PREFIX)) {
        const datePart = key.slice(RAN_PREFIX.length);
        if (DATE_ONLY.test(datePart) && datePart !== today && datePart < cutoff) {
          doomed.push(key);
        }
      }
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing to prune */
  }
}

/**
 * Reminder candidates for a day. Prefers the bounded server query, which sees
 * old overdue tasks outside the client's loaded timeline window; falls back to
 * the cached task window when the request fails so reminders never vanish.
 */
async function reminderCandidates(tasks: Task[], before: string): Promise<ReminderCandidate[]> {
  try {
    const rows = await api.get<ReminderTaskRow[]>(
      `/notifications/reminder-tasks?before=${before}&limit=100`
    );
    return (rows || [])
      .map((row) => ({
        id: row.id,
        title: row.title,
        date: (row.due_date || row.start_date) as string,
      }))
      .filter((row) => Boolean(row.date));
  } catch {
    return tasks
      .filter((t) => {
        if (t.deleted_at || t.is_archived) return false;
        if (isDoneOrCancelled(t.status)) return false;
        // Per-task opt-in: reminders are off unless the user marked the task.
        if (!t.reminder_enabled) return false;
        const date = t.due_date || t.start_date;
        return date ? date <= before : false;
      })
      .map((t) => ({
        id: t.id,
        title: t.title,
        date: (t.due_date || t.start_date) as string,
      }));
  }
}

/**
 * In-app reminder engine. Once per day, at the user's reminder time, it surfaces
 * the tasks due tomorrow plus any still-open overdue tasks as persistent
 * bottom-right cards (one per task per day, capped at ``REMINDER_CAP`` visible
 * with a "+N more" overflow). Runs entirely client-side; email reminders are a
 * separate optional channel.
 */
export function useInAppReminders() {
  const tasks = useAppStore((s) => s.tasks);
  const { prefs, loaded } = useNotificationPrefs();
  const { updateTask } = useTasks();
  const [reminders, setReminders] = useState<InAppReminder[]>([]);
  const snoozeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const evaluatingRef = useRef(false);

  const evaluate = useCallback(async () => {
    if (!prefs.inapp_reminders) return;
    if (evaluatingRef.current) return;

    const now = new Date();
    const [hour, minute] = (prefs.reminder_time || "20:00").split(":").map(Number);
    const reached =
      now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
    if (!reached) return;

    const today = toLocalDateString(now);
    const runKey = `${RAN_PREFIX}${today}`;
    if (safeGet(runKey)) return;

    evaluatingRef.current = true;
    try {
      pruneStorage(today);
      const before = tomorrowISO();
      const candidates = await reminderCandidates(tasks, before);
      const fresh = candidates.filter(
        (c) => !safeGet(`${REMINDED_PREFIX}${c.id}_${today}`)
      );
      safeSet(runKey, "1");
      if (fresh.length === 0) return;

      for (const candidate of fresh) {
        safeSet(`${REMINDED_PREFIX}${candidate.id}_${today}`, "1");
      }
      // The Electron desktop app surfaces reminders as real OS notifications
      // instead of the in-app card stack.
      if (getDesktopBridge()) {
        const title =
          fresh.length === 1 ? fresh[0].title : `${fresh.length} tasks due soon`;
        const body = fresh.slice(0, 5).map((c) => c.title).join("\n");
        openDesktopNotification({ title, body });
        return;
      }
      setReminders((prev) => {
        const existing = new Set(prev.map((r) => r.taskId));
        const next = fresh
          .filter((c) => !existing.has(c.id))
          .map<InAppReminder>((c) => ({
            taskId: c.id,
            title: c.title,
            dueDate: c.date,
          }));
        if (next.length === 0) return prev;
        return [...prev, ...next].sort(byDateThenTitle);
      });
      if (prefs.push_enabled) {
        const title =
          fresh.length === 1 ? fresh[0].title : `${fresh.length} tasks due soon`;
        const body = fresh.slice(0, 5).map((c) => c.title).join("\n");
        showSystemNotification(title, body);
      }
      if (prefs.sound) playReminderPing();
    } finally {
      evaluatingRef.current = false;
    }
  }, [tasks, prefs.inapp_reminders, prefs.reminder_time, prefs.sound, prefs.push_enabled]);

  useEffect(() => {
    if (!loaded) return;
    void evaluate();
    const id = setInterval(() => void evaluate(), CHECK_INTERVAL);
    return () => clearInterval(id);
  }, [loaded, evaluate]);

  // Cross-device sync: re-evaluate after the foreground task refresh so a task
  // added/edited elsewhere can surface here without a reload.
  useEffect(() => {
    const onRefresh = () => void evaluate();
    window.addEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
  }, [evaluate]);

  useEffect(() => {
    const timers = snoozeTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const dismiss = useCallback((taskId: string) => {
    setReminders((prev) => prev.filter((r) => r.taskId !== taskId));
  }, []);

  const complete = useCallback(
    async (taskId: string) => {
      dismiss(taskId);
      try {
        await updateTask(taskId, { status: "done" });
      } catch {
        /* the task list refetch reconciles; nothing to undo here */
      }
    },
    [dismiss, updateTask]
  );

  const snooze = useCallback(
    (taskId: string) => {
      const reminder = reminders.find((r) => r.taskId === taskId);
      dismiss(taskId);
      if (!reminder) return;
      const existing = snoozeTimers.current[taskId];
      if (existing) clearTimeout(existing);
      snoozeTimers.current[taskId] = setTimeout(() => {
        delete snoozeTimers.current[taskId];
        setReminders((prev) => {
          if (prev.some((r) => r.taskId === taskId)) return prev;
          return [...prev, reminder].sort(byDateThenTitle);
        });
        if (prefs.sound) playReminderPing();
      }, SNOOZE_MS);
    },
    [reminders, dismiss, prefs.sound]
  );

  const open = useCallback(async (taskId: string) => {
    const store = useAppStore.getState();
    // The reminder can reference a task outside the currently loaded window
    // (e.g. a far overdue task); the drawer reads from the store, so fetch and
    // merge it first or "Open" appeared to do nothing.
    if (!store.tasks.some((t) => t.id === taskId)) {
      try {
        const task = await api.get<Task>(`/tasks/${taskId}`);
        if (task) {
          const current = useAppStore.getState();
          if (!current.tasks.some((t) => t.id === task.id)) {
            current.setTasks([...current.tasks, task]);
          }
        }
      } catch {
        /* fall through: selecting an unknown id is a no-op in the drawer */
      }
    }
    useAppStore.getState().setSelectedTaskId(taskId);
  }, []);

  // The full ordered list is kept in state; the stack shows the first
  // REMINDER_CAP and reports the remainder as "+N more".
  return { reminders, total: reminders.length, dismiss, complete, snooze, open };
}
