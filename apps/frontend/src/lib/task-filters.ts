import type { Task } from "@/types/task";
import type { NavFilter } from "@/stores/app-store";
import { todayISO } from "@/lib/dates";

/** True when a date string is today (in the user's configured timezone). */
export function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return dateStr === todayISO();
}

/**
 * True when a date lands in the "Next 7 Days" window: tomorrow through today+7
 * (7 days, inclusive). Starting tomorrow keeps it disjoint from "Today" so the
 * two smart lists never double count the same task.
 */
export function isWithinNext7Days(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const start = new Date(`${todayISO()}T00:00:00`);
  const tomorrow = new Date(start);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekLater = new Date(start);
  weekLater.setDate(weekLater.getDate() + 7);
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= tomorrow && d <= weekLater;
}

/**
 * Base visibility predicate shared by every view and the sidebar counts:
 * cancelled, archived and subtask rows never surface as top-level tasks.
 */
export function isVisibleTask(task: Task): boolean {
  return task.status !== "cancelled" && !task.is_archived && !task.parent_task_id;
}

/** Apply a smart-list filter. `null` returns the tasks unchanged. */
export function applyNavFilter(tasks: Task[], filter: NavFilter): Task[] {
  if (!filter) return tasks;
  switch (filter) {
    case "inbox":
      return tasks.filter((t) => !t.start_date && !t.due_date);
    case "today":
      return tasks.filter((t) => isToday(t.start_date) || isToday(t.due_date));
    case "next7":
      return tasks.filter((t) => isWithinNext7Days(t.start_date) || isWithinNext7Days(t.due_date));
    case "all":
      return tasks;
    case "completed":
      return tasks.filter((t) => t.status === "done");
    default:
      // Unknown or stale persisted filter value: never blank the view.
      return tasks;
  }
}

/** Human-readable label for each smart-list filter (used by the toolbar chip). */
export const NAV_FILTER_LABELS: Record<NonNullable<NavFilter>, string> = {
  inbox: "Inbox",
  today: "Today",
  next7: "Next 7 Days",
  all: "All Tasks",
  completed: "Completed",
};

/** Label for the active smart-list filter, or null when no smart list is active. */
export function navFilterLabel(filter: NavFilter): string | null {
  return filter ? NAV_FILTER_LABELS[filter] : null;
}

export interface SmartListCounts {
  today: number;
  next7: number;
  all: number;
  completed: number;
}

/** Counts for the four smart lists, derived from the same predicates as the views. */
export function smartListCounts(tasks: Task[]): SmartListCounts {
  const active = tasks.filter(isVisibleTask);
  return {
    today: active.filter((t) => isToday(t.start_date) || isToday(t.due_date)).length,
    next7: active.filter((t) => isWithinNext7Days(t.start_date) || isWithinNext7Days(t.due_date)).length,
    all: active.length,
    completed: tasks.filter((t) => t.status === "done" && !t.is_archived).length,
  };
}
