import { describe, expect, it } from "vitest";
import {
  DAY_WIDTH,
  PHONE_BREAKPOINT,
  PHONE_DAY_WIDTH_MIN,
  responsiveDayWidth,
} from "./constants";

describe("responsiveDayWidth", () => {
  it("keeps the full desktop column at and above the phone breakpoint", () => {
    for (const vw of [PHONE_BREAKPOINT, 1024, 1280, 1440, 2560]) {
      expect(responsiveDayWidth(vw)).toBe(DAY_WIDTH);
    }
  });

  it("never shrinks a phone column below the readable minimum", () => {
    for (const vw of [320, 360, 375, 390, 412, 430, 767]) {
      expect(responsiveDayWidth(vw)).toBeGreaterThanOrEqual(PHONE_DAY_WIDTH_MIN);
      expect(responsiveDayWidth(vw)).toBeLessThanOrEqual(DAY_WIDTH);
    }
  });

  it("gives a phone a wider column than the old 56px clamp", () => {
    // The old formula was clamp(56, vw * 0.15, 120); at 412px it produced 62px,
    // which clipped every bar label to a few characters.
    expect(responsiveDayWidth(412)).toBeGreaterThan(88);
  });

  it("grows smoothly with the viewport inside the phone range", () => {
    const narrow = responsiveDayWidth(375);
    const wide = responsiveDayWidth(430);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe("useTimelineMetrics zoom wiring", () => {
  // The reported bug: the day columns widen with the view zoom while the bars
  // and their labels stay at the interface size, so a 200% timeline is double
  // width columns holding tiny clipped titles.
  it("grows the bar and the label with the timeline zoom", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { setTimelineZoom } = await import("@/lib/view-zoom");
    const { useTimelineMetrics } = await import("./constants");

    const { result } = renderHook(() => useTimelineMetrics());
    const base = result.current;

    act(() => setTimelineZoom(2));
    const zoomed = result.current;

    expect(zoomed.barHeight).toBeGreaterThan(base.barHeight);
    expect(zoomed.barGap).toBeGreaterThan(base.barGap);
    expect(zoomed.labelPx).toBeGreaterThan(base.labelPx);
    // Damped: a 2x column must not produce 2x rows, or one task fills the screen.
    expect(zoomed.barHeight).toBeLessThan(base.barHeight * 2);
    expect(zoomed.labelPx).toBeLessThanOrEqual(22);

    act(() => setTimelineZoom(1));
  });
});
