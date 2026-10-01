import type { Task } from "@/types/task";
import { parseLocalDate, toLocalDateString } from "@/lib/utils";

export type BarDragMode = "move" | "resize-left" | "resize-right";

/**
 * Raw pixel offset of a gesture, combining the pointer displacement with any
 * canvas auto-scroll that happened during the gesture.
 *
 * `dx` is the pointer's screen displacement; `scrollDelta` is
 * `body.scrollLeft - startScrollLeft`. Because a bar's on-screen position is
 * `homeContentX + transform - scrollLeft`, compensating for the scroll is what
 * makes a task dropped after edge auto-scroll land on the day under the
 * pointer instead of `scrollDelta / dayWidth` days short.
 *
 * This is deliberately un-snapped: the drag preview follows the pointer
 * pixel-for-pixel, and only the drop is quantized (`computeDragDays`).
 */
export function dragOffsetPx(input: { dx: number; scrollDelta?: number }): number {
  const total = input.dx + (input.scrollDelta ?? 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Whole days a bar commits on drop, from the same `dx`/`scrollDelta` pair the
 * preview used. Rounds to the nearest day; a drag shorter than half a day is a
 * no-op instead of a forced one-day jump, so a small hand jitter never moves a
 * task.
 */
export function computeDragDays(input: {
  dx: number;
  scrollDelta?: number;
  dayWidth: number;
}): number {
  const { dayWidth } = input;
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) return 0;
  const total = dragOffsetPx(input);
  if (total === 0) return 0;
  const days = Math.round(total / dayWidth);
  // Normalize -0 to 0 so callers never see a negative zero day count.
  return days === 0 ? 0 : days;
}

function shiftIso(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
}

/**
 * Date fields for moving a task by whole days. Undated tasks gain both dates so
 * a dropped inbox task lands on a real day.
 */
export function applyMoveDays(
  task: Task,
  days: number,
  today: Date = new Date()
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (task.start_date) fields.start_date = shiftIso(task.start_date, days);
  if (task.due_date) fields.due_date = shiftIso(task.due_date, days);
  if (!task.start_date && !task.due_date) {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    const iso = toLocalDateString(d);
    fields.start_date = iso;
    fields.due_date = iso;
  }
  return fields;
}

/**
 * Date fields for resizing a task by whole days. The left handle moves the
 * start, the right handle moves the due. A task with only one bound extends
 * from the bound it has; a fully undated task anchors on `today`.
 */
export function applyResizeDays(
  task: Task,
  days: number,
  side: "left" | "right",
  today: Date = new Date()
): Record<string, string> {
  if (side === "left") {
    const anchor = task.start_date ?? task.due_date ?? toLocalDateString(today);
    return { start_date: shiftIso(anchor, days) };
  }
  const anchor = task.due_date ?? task.start_date ?? toLocalDateString(today);
  return { due_date: shiftIso(anchor, days) };
}
