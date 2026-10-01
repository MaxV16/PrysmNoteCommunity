import type { Task } from "@/types/task";
import { parseLocalDate } from "@/lib/utils";
import { todayStart } from "@/lib/dates";
import { BAR_HEIGHT, BAR_GAP, TOP_PADDING } from "./constants";

export interface PositionedTask {
  task: Task;
  pos: {
    left: string;
    width: string;
    dayIndex: number;
    top: number;
  };
}

/**
 * Day-column span of a task within the rendered range, or null if it does not
 * overlap the window at all.
 *
 * The test is an OVERLAP, not containment: a task that runs for months must stay
 * visible while the viewport moves through its middle, even though its start
 * date has scrolled out of the rendered slice. The span is clamped to the
 * window so the bar (and its width) never extends past the rendered columns.
 */
function getTaskDayInfo(task: Task, days: Date[]): { index: number; endIndex: number } | null {
  const taskStart = task.start_date ? parseLocalDate(task.start_date) : null;
  const taskEnd = task.due_date ? parseLocalDate(task.due_date) : null;
  if (!taskStart && !taskEnd) return null;

  const windowStart = new Date(days[0]);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(days[days.length - 1]);
  windowEnd.setHours(0, 0, 0, 0);

  // A task with only one bound covers that single day; tolerate a swapped range.
  const anchor = taskStart ?? taskEnd!;
  const other = taskEnd ?? taskStart!;
  const rangeStart = anchor <= other ? anchor : other;
  const rangeEnd = anchor <= other ? other : anchor;

  if (rangeEnd < windowStart || rangeStart > windowEnd) return null;

  const DAY_MS = 1000 * 60 * 60 * 24;
  const index = Math.max(
    0,
    Math.round((rangeStart.getTime() - windowStart.getTime()) / DAY_MS)
  );
  const endIndex = Math.min(
    days.length - 1,
    Math.round((rangeEnd.getTime() - windowStart.getTime()) / DAY_MS)
  );
  if (endIndex < index) return null;

  return { index, endIndex };
}

// Today's index within the rendered day range, or -1 if today isn't visible.
// Uses the same configured/device timezone as the timeline anchor so the
// undated pin, header highlight and grid line never disagree.
function todayIndex(days: Date[]): number {
  const today = todayStart();
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Shared timeline lane layout. Both the rendered lane and the left swimlane
 * label column use this so their heights line up exactly; keeping one algorithm
 * avoids the cumulative misalignment that comes from guessing each height.
 */
export function computeLaneLayout(tasks: Task[], days: Date[]): {
  positioned: PositionedTask[];
  maxStack: number;
  height: number;
} {
  if (days.length === 0) {
    return { positioned: [], maxStack: 0, height: TOP_PADDING * 2 };
  }

  // Day column index for "today", used to place undated (inbox) tasks so they
  // are visible and draggable on the timeline. Falls back to the middle day if
  // today isn't in range.
  const todayIdx = todayIndex(days);
  const undatedIdx = todayIdx >= 0 ? todayIdx : Math.floor(days.length / 2);

  // Determine day column spans for each task.
  const candidates: { task: Task; info: { index: number; endIndex: number } }[] = [];
  for (const task of tasks) {
    const info = getTaskDayInfo(task, days);
    if (info) {
      candidates.push({ task, info });
    } else if (!task.start_date && !task.due_date) {
      // Undated task: pin to today's column so it can be grabbed and dragged
      // onto a date.
      candidates.push({ task, info: { index: undatedIdx, endIndex: undatedIdx } });
    }
  }

  // Assign a vertical stack row per task. A task may reuse a row across the
  // whole day range it spans if that row is free on every day it occupies.
  // Occupancy is stored as a Set per row so conflict checks stay O(span)
  // instead of rescanning a growing array for every candidate row.
  const occupiedByRow: Record<number, Set<number>> = {};
  const assigned: { task: Task; info: { index: number; endIndex: number }; row: number }[] = [];

  // Same-day order is deterministic: span start first, then timed tasks earlier
  // in the day sit above later ones, untimed after, then priority and title so
  // first-fit rows follow a stable, useful order. The primary key is the task's
  // absolute date (not its clamped slice index) so a bar does not change rows
  // just because the rendered slice moved.
  const sortKeyFor = (task: Task): number => {
    const s = task.start_date ? parseLocalDate(task.start_date) : null;
    const d = task.due_date ? parseLocalDate(task.due_date) : null;
    const anchor = s ?? d;
    if (anchor) return anchor.getTime();
    const pinned = new Date(days[undatedIdx]);
    pinned.setHours(0, 0, 0, 0);
    return pinned.getTime();
  };
  const sortedCandidates = [...candidates].sort((a, b) => {
    const d = sortKeyFor(a.task) - sortKeyFor(b.task);
    if (d !== 0) return d;
    const at = a.task.start_time ?? "";
    const bt = b.task.start_time ?? "";
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    if (at && bt && at !== bt) return at < bt ? -1 : 1;
    const p = a.task.priority - b.task.priority;
    if (p !== 0) return p;
    return a.task.title.localeCompare(b.task.title);
  });

  for (const c of sortedCandidates) {
    const daysOccupied: number[] = [];
    for (let i = c.info.index; i <= c.info.endIndex; i++) daysOccupied.push(i);
    let row = 0;
    for (;; row++) {
      const occ = occupiedByRow[row];
      if (!occ || !daysOccupied.some((d) => occ.has(d))) {
        const set = occ ?? new Set<number>();
        for (const d of daysOccupied) set.add(d);
        occupiedByRow[row] = set;
        break;
      }
    }
    assigned.push({ ...c, row });
  }

  const totalRows = assigned.reduce((m, a) => Math.max(m, a.row + 1), 0);

  const positioned: PositionedTask[] = assigned.map(({ task, info, row }) => ({
    task,
    pos: {
      left: `${info.index * (100 / days.length)}%`,
      width: `${(info.endIndex - info.index + 1) * (100 / days.length)}%`,
      dayIndex: info.index,
      top: TOP_PADDING + row * (BAR_HEIGHT + BAR_GAP),
    },
  }));

  const height = TOP_PADDING * 2 + Math.max(1, totalRows) * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  return { positioned, maxStack: totalRows, height };
}
