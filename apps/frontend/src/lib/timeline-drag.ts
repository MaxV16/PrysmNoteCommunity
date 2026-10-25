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
 * Pointer position in the canvas' *content* coordinate space.
 *
 * A pointer's screen x is stable, but the content under it moves whenever the
 * canvas scrolls (native pan, momentum, a scrollbar drag, or the drag engine's
 * own edge auto-scroll). Adding the CURRENT `scrollLeft` converts the pointer
 * to the content coordinate it is actually over, which is what a drop must use.
 * The old engine trusted a single `startScrollLeft` sample plus an accumulated
 * delta, so a native scroll that arrived late (a Windows precision touchscreen
 * pan or its momentum) left the baseline stale and teleported the bar and the
 * viewport. Sampling the live offset makes the baseline impossible to go stale.
 */
export function pointerContentX(input: {
  clientX: number;
  bodyLeft: number;
  scrollLeft: number;
}): number {
  const value = input.clientX - input.bodyLeft + input.scrollLeft;
  return Number.isFinite(value) ? value : 0;
}

/** Raw pixel offset between the press anchor and the pointer, in content space. */
export function dragOffsetFromContent(input: {
  startContentX: number;
  pointerContentX: number;
}): number {
  const total = input.pointerContentX - input.startContentX;
  return Number.isFinite(total) ? total : 0;
}

/**
 * Whole days a bar would move if dropped with the pointer at
 * `pointerContentX`.
 *
 * The anchor is the pointer's content position at press, so the result is the
 * day delta of the pointer itself. It is deliberately independent of the bar's
 * rendered pixel width: the same gesture lands on the same day whether the
 * canvas scrolled under the finger or the viewport zoomed mid-drag.
 */
export function dragDaysFromContent(input: {
  startContentX: number;
  pointerContentX: number;
  dayWidth: number;
}): number {
  const { dayWidth } = input;
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) return 0;
  const days = Math.round(
    dragOffsetFromContent(input) / dayWidth
  );
  return days === 0 ? 0 : days;
}

/**
 * Where inside its own rendered rect a bar was grabbed, in content pixels.
 * Used so a bar grabbed near its end still lands with the grabbed point (not
 * its left edge) under the pointer, and so a bar whose screen rect shifted
 * mid-gesture cannot offset the day math.
 */
export function grabOffsetWithinBar(input: {
  startContentX: number;
  barContentLeft: number;
}): number {
  const value = input.startContentX - input.barContentLeft;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Day delta for a bar anchored by its own left edge: the bar's target left is
 * `pointerContentX - grabOffsetPx`, and the delta is measured from the bar's
 * pre-drag content left. With a consistent grab offset this equals
 * `dragDaysFromContent`, but expressing it from the bar rect is the contract
 * the pointer engine uses, so a stale screen position cannot leak in.
 */
export function dragDaysForBar(input: {
  pointerContentX: number;
  barContentLeft: number;
  grabOffsetPx: number;
  dayWidth: number;
}): number {
  if (!Number.isFinite(input.dayWidth) || input.dayWidth <= 0) return 0;
  const targetLeft = input.pointerContentX - input.grabOffsetPx;
  const days = Math.round((targetLeft - input.barContentLeft) / input.dayWidth);
  return days === 0 ? 0 : days;
}

/**
 * Snap a raw pixel offset to the nearest whole day column. Used by the resize
 * preview so the bar (and its live date badge) land on day boundaries while the
 * handle is dragged, exactly where the drop commits, instead of sliding
 * variably between columns. Falls back to the raw offset when the day width is
 * unknown.
 */
export function snapOffsetPx(offset: number, dayWidth: number): number {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) return offset;
  const snapped = Math.round(offset / dayWidth) * dayWidth;
  // Normalise negative zero so the helper never returns -0.
  return snapped === 0 ? 0 : snapped;
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
 * Whole-day distance from `fromIso` to `toIso` (positive when `toIso` is later).
 * Used to snap a task dropped onto another task to that task's exact day, so a
 * drop near an edge cannot land one column off. Returns null when either date is
 * missing or unparseable.
 */
export function daysBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const from = parseLocalDate(fromIso);
  const to = parseLocalDate(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
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
 * start, the right handle moves the due. The edge that is NOT dragged stays
 * anchored, and both bounds are always returned so a task with only one bound
 * grows a real span instead of sliding. The span is clamped so the bar can
 * never invert or collapse below a single day.
 */
export function applyResizeDays(
  task: Task,
  days: number,
  side: "left" | "right",
  today: Date = new Date()
): Record<string, string> {
  const todayIso = toLocalDateString(today);
  const baseStart = task.start_date ?? task.due_date ?? todayIso;
  const baseDue = task.due_date ?? task.start_date ?? todayIso;
  // Normalize an inverted (start > due) input so the clamp bounds are sane.
  const lo = baseStart <= baseDue ? baseStart : baseDue;
  const hi = baseStart <= baseDue ? baseDue : baseStart;
  if (side === "left") {
    const moved = shiftIso(lo, days);
    return { start_date: moved > hi ? hi : moved, due_date: hi };
  }
  const moved = shiftIso(hi, days);
  return { start_date: lo, due_date: moved < lo ? lo : moved };
}

/**
 * The start/end dates a resize drag would commit if released now, for the live
 * badge shown above the bar. Mirrors `applyResizeDays` exactly so the preview
 * and the drop can never disagree: the bound being dragged moves, the other
 * bound stays put. Returns null when the task has no date to anchor on.
 */
export function resizePreviewRange(
  task: Task,
  days: number,
  side: "left" | "right"
): { start: string; due: string } | null {
  const baseStart = task.start_date ?? task.due_date ?? null;
  const baseDue = task.due_date ?? task.start_date ?? null;
  if (!baseStart || !baseDue) return null;
  const changed = applyResizeDays(task, days, side);
  return {
    start: changed.start_date ?? baseStart,
    due: changed.due_date ?? baseDue,
  };
}

/**
 * Inclusive day span a task currently occupies, from its dates. A task with one
 * or no date occupies a single day. Used by the resize preview so a bar is
 * drawn from its real span instead of its rendered (possibly slice-clamped)
 * pixel width, which is what made a long task collapse to a tiny bar the moment
 * you started dragging a handle.
 */
export function taskSpanDays(task: Task): number {
  const baseStart = task.start_date ?? task.due_date ?? null;
  const baseDue = task.due_date ?? task.start_date ?? null;
  if (!baseStart || !baseDue) return 1;
  const lo = parseLocalDate(baseStart <= baseDue ? baseStart : baseDue);
  const hi = parseLocalDate(baseStart <= baseDue ? baseDue : baseStart);
  const diff = Math.round((hi.getTime() - lo.getTime()) / 86400000);
  return Math.max(1, diff + 1);
}

/**
 * The whole-day span a resize drag is showing right now, from the task's base
 * span and the day delta of the gesture. Mirrors `applyResizeDays` in days:
 * the right handle grows/shrinks the end, the left handle moves the start, and
 * the span is clamped to at least one day. `leftShiftDays` is how many days the
 * left edge has moved (negative means it moved earlier), so a left resize keeps
 * its right edge anchored. Working in days, not pixels, is what keeps the live
 * preview exactly equal to the committed slot.
 */
export function resizePreviewSpan(
  baseSpanDays: number,
  days: number,
  side: "left" | "right"
): { spanDays: number; leftShiftDays: number } {
  const span = Math.max(1, Math.round(baseSpanDays));
  if (side === "right") {
    return { spanDays: Math.max(1, span + days), leftShiftDays: 0 };
  }
  const clamped = Math.min(days, span - 1);
  return { spanDays: Math.max(1, span - clamped), leftShiftDays: clamped };
}
