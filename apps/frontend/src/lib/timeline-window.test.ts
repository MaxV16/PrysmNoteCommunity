import { describe, expect, it } from "vitest";
import {
  TIMELINE_BASE_LEFT_OFFSET,
  TIMELINE_MAX_SLICE_START,
  TIMELINE_ORIGIN_DAYS,
  TIMELINE_RENDER_DAYS,
  TIMELINE_SLICE_TRIGGER_DAYS,
  TIMELINE_TODAY_INDEX,
  TIMELINE_TOTAL_DAYS,
  clampDayIndex,
  clampSliceStart,
  dateForDayIndex,
  dayIndexForDate,
  dayOffsetForIndex,
  initialSliceStart,
  monthLabelForViewport,
  scrollLeftForDayIndex,
  scrollLeftToCenterDay,
  sliceStartForViewport,
  totalCanvasWidth,
} from "./timeline-window";

const TODAY = new Date(2026, 8, 16); // Sep 16 2026
const DAY_WIDTH = 120;
const CLIENT_WIDTH = 1000;

/**
 * Regression: the timeline used to stop at a fixed date (today + 99, i.e.
 * Dec 24 when today is Sep 16) because the mount expansion capped the canvas.
 * The canvas is now a fixed, very wide strip, so any date in it is reachable and
 * scrolling can never be blocked or moved backwards.
 */
describe("day strip geometry", () => {
  it("places today at the middle index and maps offsets both ways", () => {
    expect(TIMELINE_TODAY_INDEX).toBe(-TIMELINE_ORIGIN_DAYS);
    expect(dayOffsetForIndex(TIMELINE_TODAY_INDEX)).toBe(0);
    const date = dateForDayIndex(TIMELINE_TODAY_INDEX + 99, TODAY);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(11);
    expect(date.getDate()).toBe(24); // the old wall, now just a reachable day
    expect(dayIndexForDate(date, TODAY)).toBe(TIMELINE_TODAY_INDEX + 99);
  });

  it("round-trips every day across a wide span", () => {
    for (let offset = -3650; offset <= 3650; offset += 17) {
      const index = TIMELINE_TODAY_INDEX + offset;
      const date = dateForDayIndex(index, TODAY);
      expect(dayIndexForDate(date, TODAY)).toBe(index);
    }
  });

  it("keeps the whole strip inside browser scroll limits", () => {
    // Chromium tops out near 33.5M px; stay comfortably below it.
    expect(totalCanvasWidth(DAY_WIDTH)).toBeLessThan(33_554_432);
    expect(totalCanvasWidth(56)).toBeLessThan(33_554_432);
  });

  it("clamps out-of-range indices instead of throwing", () => {
    expect(clampDayIndex(-999)).toBe(0);
    expect(clampDayIndex(TIMELINE_TOTAL_DAYS + 999)).toBe(TIMELINE_TOTAL_DAYS - 1);
    expect(clampDayIndex(NaN)).toBe(TIMELINE_TODAY_INDEX);
    expect(clampSliceStart(NaN)).toBe(initialSliceStart());
    expect(clampSliceStart(-5)).toBe(0);
    expect(clampSliceStart(Infinity)).toBe(TIMELINE_MAX_SLICE_START);
    expect(scrollLeftForDayIndex(-5, DAY_WIDTH)).toBe(0);
  });

  it("opens on a slice with a large forward horizon", () => {
    const start = initialSliceStart();
    expect(start).toBeLessThanOrEqual(TIMELINE_TODAY_INDEX - TIMELINE_BASE_LEFT_OFFSET);
    const forwardHorizon =
      start + TIMELINE_RENDER_DAYS - (TIMELINE_TODAY_INDEX - TIMELINE_BASE_LEFT_OFFSET);
    expect(forwardHorizon).toBeGreaterThan(150);
  });
});

describe("scrollLeftToCenterDay", () => {
  it("places the day's column centre at the viewport centre", () => {
    const scrollLeft = scrollLeftToCenterDay(TIMELINE_TODAY_INDEX, DAY_WIDTH, CLIENT_WIDTH);
    const columnCentre = TIMELINE_TODAY_INDEX * DAY_WIDTH + DAY_WIDTH / 2;
    expect(scrollLeft + CLIENT_WIDTH / 2).toBeCloseTo(columnCentre, 5);
  });

  it("stays centred across window widths and day column widths", () => {
    for (const dayWidth of [56, 120]) {
      for (const clientWidth of [360, 768, 1440]) {
        const scrollLeft = scrollLeftToCenterDay(TIMELINE_TODAY_INDEX, dayWidth, clientWidth);
        const columnCentre = TIMELINE_TODAY_INDEX * dayWidth + dayWidth / 2;
        expect(scrollLeft + clientWidth / 2).toBeCloseTo(columnCentre, 5);
      }
    }
  });

  it("clamps to zero at the very start of the strip", () => {
    expect(scrollLeftToCenterDay(0, DAY_WIDTH, CLIENT_WIDTH)).toBe(0);
  });
});

/**
 * Regression: the toolbar month label used to be derived from the viewport
 * CENTRE, so a width-only change (toggling the AI dock shrinks the canvas by
 * 360px) moved the centre by up to 1.5 days and flipped the label across a
 * month boundary even though the user never scrolled. The label is now anchored
 * to the LEFT edge, which does not move on a width change.
 */
describe("monthLabelForViewport", () => {
  it("is invariant to a width-only change at the same scroll offset", () => {
    // Left edge Sep 5 2026, comfortably inside the month for both widths.
    const leftIndex = dayIndexForDate(new Date(2026, 8, 5), TODAY);
    const scrollLeft = scrollLeftForDayIndex(leftIndex, DAY_WIDTH);
    const wide = monthLabelForViewport({ scrollLeft, clientWidth: 1200, dayWidth: DAY_WIDTH, today: TODAY });
    const narrow = monthLabelForViewport({ scrollLeft, clientWidth: 840, dayWidth: DAY_WIDTH, today: TODAY });
    expect(wide).toBe("September 2026");
    expect(narrow).toBe(wide);
  });

  it("reports a month range when the viewport spans a boundary", () => {
    const leftIndex = dayIndexForDate(new Date(2026, 8, 28), TODAY);
    const scrollLeft = scrollLeftForDayIndex(leftIndex, DAY_WIDTH);
    const label = monthLabelForViewport({
      scrollLeft,
      clientWidth: 1200,
      dayWidth: DAY_WIDTH,
      today: TODAY,
    });
    expect(label).toBe("Sep - Oct 2026");
  });

  it("includes both years when the viewport crosses a year boundary", () => {
    const leftIndex = dayIndexForDate(new Date(2026, 11, 28), TODAY);
    const scrollLeft = scrollLeftForDayIndex(leftIndex, DAY_WIDTH);
    const label = monthLabelForViewport({
      scrollLeft,
      clientWidth: 1200,
      dayWidth: DAY_WIDTH,
      today: TODAY,
    });
    expect(label).toBe("Dec 2026 - Jan 2027");
  });
});

describe("sliceStartForViewport", () => {
  it("keeps the slice while the viewport is comfortably inside it", () => {
    const start = initialSliceStart();
    const scrollLeft = (TIMELINE_TODAY_INDEX - TIMELINE_BASE_LEFT_OFFSET) * DAY_WIDTH;
    expect(
      sliceStartForViewport({ scrollLeft, clientWidth: CLIENT_WIDTH, dayWidth: DAY_WIDTH, currentStart: start })
    ).toBe(null);
  });

  it("moves the slice on when the viewport nears its end", () => {
    const start = 0;
    const viewportStart = TIMELINE_RENDER_DAYS - TIMELINE_SLICE_TRIGGER_DAYS + 1;
    const scrollLeft = viewportStart * DAY_WIDTH;
    const next = sliceStartForViewport({
      scrollLeft,
      clientWidth: CLIENT_WIDTH,
      dayWidth: DAY_WIDTH,
      currentStart: start,
    });
    expect(next).not.toBe(null);
    if (next === null) return;
    expect(next).toBeGreaterThan(start);
    // The new slice must fully cover the viewport.
    expect(next).toBeLessThanOrEqual(viewportStart);
  });

  it("moves the slice back when the viewport nears its start", () => {
    const start = 1000;
    const viewportStart = start + TIMELINE_SLICE_TRIGGER_DAYS;
    const scrollLeft = viewportStart * DAY_WIDTH;
    const next = sliceStartForViewport({
      scrollLeft,
      clientWidth: CLIENT_WIDTH,
      dayWidth: DAY_WIDTH,
      currentStart: start,
    });
    expect(next).not.toBe(null);
    if (next === null) return;
    expect(next).toBeLessThan(start);
    expect(next + TIMELINE_RENDER_DAYS).toBeGreaterThanOrEqual(viewportStart);
  });

  it("never leaves a gap in front of the viewport", () => {
    // Walk the viewport forward across the whole strip, rebuilding the slice the
    // way the component does. At every step the rendered slice must cover the
    // viewport with slack, so scrolling can never reach an empty area.
    let start = initialSliceStart();
    let scrollLeft = (TIMELINE_TODAY_INDEX - TIMELINE_BASE_LEFT_OFFSET) * DAY_WIDTH;
    const viewportDays = CLIENT_WIDTH / DAY_WIDTH;
    let travelled = 0;

    for (let step = 0; step < 2000; step++) {
      scrollLeft += DAY_WIDTH * 5; // scroll five days per step
      travelled += 5;
      const next = sliceStartForViewport({
        scrollLeft,
        clientWidth: CLIENT_WIDTH,
        dayWidth: DAY_WIDTH,
        currentStart: start,
      });
      if (next !== null) start = next;
      const viewportStart = Math.floor(scrollLeft / DAY_WIDTH);
      const viewportEnd = Math.ceil((scrollLeft + CLIENT_WIDTH) / DAY_WIDTH);
      expect(start).toBeLessThanOrEqual(viewportStart);
      expect(start + TIMELINE_RENDER_DAYS).toBeGreaterThanOrEqual(viewportEnd);
      // The physical end of the strip must stay decades away, never at the
      // viewport, so the user can always keep scrolling forward.
      expect(TIMELINE_TOTAL_DAYS - viewportEnd).toBeGreaterThan(18000);
    }
    expect(travelled).toBe(10000);
  });
});
