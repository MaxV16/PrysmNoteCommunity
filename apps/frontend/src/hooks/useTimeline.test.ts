import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const todayMock = vi.fn(() => new Date(2026, 9, 14, 0, 0, 0));

vi.mock("@/lib/dates", () => ({
  todayStart: () => todayMock(),
}));

import { useTimeline } from "./useTimeline";

const DAY_MS = 1000 * 60 * 60 * 24;

describe("useTimeline day sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    todayMock.mockReturnValue(new Date(2026, 9, 14, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rolls today forward after the day changes without a remount", () => {
    const { result } = renderHook(() => useTimeline());
    expect(result.current.today.getDate()).toBe(14);
    const firstDay = result.current.days[0].getTime();

    // The clock crosses midnight while the app stays open.
    todayMock.mockReturnValue(new Date(2026, 9, 15, 0, 0, 0));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.today.getDate()).toBe(15);
    expect(result.current.days[0].getTime() - firstDay).toBe(DAY_MS);
  });

  it("keeps the same Date instance when the day has not changed", () => {
    const { result } = renderHook(() => useTimeline());
    const before = result.current.today;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.today).toBe(before);
  });
});
