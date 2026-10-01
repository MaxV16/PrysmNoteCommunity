/**
 * Geometry for the timeline's scrollable canvas.
 *
 * The canvas is one very wide strip whose width never changes: every day has a
 * fixed pixel home at `dayIndex * dayWidth`. `scrollLeft` therefore maps
 * directly to a date, the browser owns scrolling end to end, and no edge
 * detection, trimming or re-anchoring can make the timeline "stop", jump, or
 * move backwards. Only a bounded slice of day columns is rendered around the
 * viewport, and because each rendered day keeps its absolute pixel position,
 * moving the slice is invisible: nothing under the viewport ever shifts.
 */

/** Days of history at index 0 (about ten years). */
export const TIMELINE_ORIGIN_DAYS = -3650;

/** Scrollable days in total (about a century). */
export const TIMELINE_TOTAL_DAYS = 36500;

/** Day columns rendered at once, around the viewport. */
export const TIMELINE_RENDER_DAYS = 260;

/** Days of history shown to the left of today when the timeline opens. */
export const TIMELINE_BASE_LEFT_OFFSET = 10;

/** Slack kept on each side of the viewport inside the rendered slice. */
export const TIMELINE_SLICE_BUFFER_DAYS = 60;

/** Rebuild the slice once the viewport comes this close to a slice edge. */
export const TIMELINE_SLICE_TRIGGER_DAYS = 30;

/** Index of today in the global day strip. */
export const TIMELINE_TODAY_INDEX = -TIMELINE_ORIGIN_DAYS;

/** Largest slice start that still renders a full slice. */
export const TIMELINE_MAX_SLICE_START = Math.max(
  0,
  TIMELINE_TOTAL_DAYS - TIMELINE_RENDER_DAYS
);

export function clampDayIndex(index: number): number {
  if (!Number.isFinite(index)) return TIMELINE_TODAY_INDEX;
  return Math.min(TIMELINE_TOTAL_DAYS - 1, Math.max(0, Math.round(index)));
}

export function clampSliceStart(start: number): number {
  if (Number.isNaN(start)) return initialSliceStart();
  return Math.min(TIMELINE_MAX_SLICE_START, Math.max(0, Math.round(start)));
}

/** Slice that covers the opening viewport with plenty of forward horizon. */
export function initialSliceStart(): number {
  return clampSliceStart(
    TIMELINE_TODAY_INDEX - TIMELINE_BASE_LEFT_OFFSET - TIMELINE_SLICE_BUFFER_DAYS
  );
}

/** Day offset from today for a global day index. */
export function dayOffsetForIndex(index: number): number {
  return TIMELINE_ORIGIN_DAYS + index;
}

export function dateForDayIndex(index: number, today: Date): Date {
  const d = new Date(today);
  d.setDate(d.getDate() + dayOffsetForIndex(index));
  return d;
}

export function dayIndexForDate(date: Date, today: Date): number {
  const diff = Math.round((date.getTime() - today.getTime()) / 86400000);
  return clampDayIndex(diff - TIMELINE_ORIGIN_DAYS);
}

export function totalCanvasWidth(dayWidth: number): number {
  return TIMELINE_TOTAL_DAYS * dayWidth;
}

export function dayIndexFromScrollLeft(scrollLeft: number, dayWidth: number): number {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(dayWidth) || dayWidth <= 0) {
    return TIMELINE_TODAY_INDEX;
  }
  return Math.floor(scrollLeft / dayWidth);
}

export function scrollLeftForDayIndex(index: number, dayWidth: number): number {
  return clampDayIndex(index) * dayWidth;
}

/**
 * Month label for the current viewport, anchored to its LEFT edge.
 *
 * Anchoring to the left edge is what stops the label from flickering when the
 * timeline column only changes width (for example the AI dock or the left
 * rail toggling): the date the user actually scrolled to does not move, so the
 * primary month stays put even though the viewport now covers more or fewer
 * days. A viewport that spans a month boundary reads as a range ("Sep - Oct
 * 2026") instead of silently flipping to the trailing month.
 */
export function monthLabelForViewport(input: {
  scrollLeft: number;
  clientWidth: number;
  dayWidth: number;
  today: Date;
}): string {
  const { scrollLeft, clientWidth, dayWidth, today } = input;
  const startIndex = dayIndexFromScrollLeft(scrollLeft, dayWidth);
  const endIndex = Math.max(
    startIndex,
    dayIndexFromScrollLeft(Math.max(0, scrollLeft + clientWidth - 1), dayWidth)
  );
  const start = dateForDayIndex(startIndex, today);
  const end = dateForDayIndex(endIndex, today);

  const sameMonth =
    start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) {
    return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  const shortMonth = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  if (start.getFullYear() === end.getFullYear()) {
    return `${shortMonth(start)} - ${shortMonth(end)} ${end.getFullYear()}`;
  }
  return `${shortMonth(start)} ${start.getFullYear()} - ${shortMonth(end)} ${end.getFullYear()}`;
}

/** Scroll offset that parks `index` at the left edge of the viewport. */
export function scrollLeftToShowDayAtLeft(
  index: number,
  dayWidth: number,
  historyDays = 0
): number {
  return scrollLeftForDayIndex(index - historyDays, dayWidth);
}

/**
 * Scroll offset that centers `index` in the viewport.
 *
 * Used for the opening view and the "Today" button so the current day always
 * lands in the middle, regardless of window width or day column width. Clamped
 * at zero so the very first days of the strip cannot scroll into a negative
 * offset.
 */
export function scrollLeftToCenterDay(
  index: number,
  dayWidth: number,
  clientWidth: number
): number {
  const centerOffset = dayWidth / 2;
  const target =
    scrollLeftForDayIndex(index, dayWidth) - clientWidth / 2 + centerOffset;
  return Math.max(0, target);
}

/**
 * The slice to render for the current viewport, or null while the existing one
 * still has enough slack on both sides. Because the rendered days keep their
 * absolute pixel positions, changing the slice never moves the content.
 */
export function sliceStartForViewport(input: {
  scrollLeft: number;
  clientWidth: number;
  dayWidth: number;
  currentStart: number;
}): number | null {
  const { scrollLeft, clientWidth, dayWidth, currentStart } = input;
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) return null;
  const viewportStart = dayIndexFromScrollLeft(scrollLeft, dayWidth);
  const viewportEnd = Math.ceil((scrollLeft + clientWidth) / dayWidth);
  const sliceEnd = currentStart + TIMELINE_RENDER_DAYS;
  const nearStart = viewportStart <= currentStart + TIMELINE_SLICE_TRIGGER_DAYS;
  const nearEnd = viewportEnd >= sliceEnd - TIMELINE_SLICE_TRIGGER_DAYS;
  if (!nearStart && !nearEnd) return null;
  const next = clampSliceStart(viewportStart - TIMELINE_SLICE_BUFFER_DAYS);
  return next === currentStart ? null : next;
}
