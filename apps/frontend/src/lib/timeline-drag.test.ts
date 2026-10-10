import { describe, expect, it } from "vitest";
import type { Task } from "@/types/task";
import {
  applyMoveDays,
  applyResizeDays,
  computeDragDays,
  daysBetween,
  dragOffsetPx,
  resizePreviewRange,
  resizePreviewSpan,
  snapOffsetPx,
  taskSpanDays,
} from "./timeline-drag";

const DAY_WIDTH = 120;
const TODAY = new Date(2026, 8, 16); // Sep 16 2026

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: 0,
    start_date: null,
    due_date: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("dragOffsetPx", () => {
  it("keeps the raw, un-snapped displacement for a smooth preview", () => {
    expect(dragOffsetPx({ dx: 37 })).toBe(37);
    expect(dragOffsetPx({ dx: 37, scrollDelta: 12 })).toBe(49);
    expect(dragOffsetPx({ dx: -95, scrollDelta: 10 })).toBe(-85);
  });

  it("is safe for missing or non-finite input", () => {
    expect(dragOffsetPx({ dx: 0 })).toBe(0);
    expect(dragOffsetPx({ dx: Number.NaN })).toBe(0);
    expect(dragOffsetPx({ dx: 10, scrollDelta: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe("snapOffsetPx", () => {
  it("snaps a resize offset to the nearest whole day column", () => {
    expect(snapOffsetPx(DAY_WIDTH * 1.4, DAY_WIDTH)).toBe(DAY_WIDTH);
    expect(snapOffsetPx(DAY_WIDTH * 1.6, DAY_WIDTH)).toBe(DAY_WIDTH * 2);
    expect(snapOffsetPx(-DAY_WIDTH * 0.4, DAY_WIDTH)).toBe(0);
    expect(snapOffsetPx(-DAY_WIDTH * 2.6, DAY_WIDTH)).toBe(-DAY_WIDTH * 3);
  });

  it("falls back to the raw offset when the day width is unknown", () => {
    expect(snapOffsetPx(37, 0)).toBe(37);
    expect(snapOffsetPx(37, Number.NaN)).toBe(37);
  });
});

describe("computeDragDays", () => {
  it("snaps pointer displacement to whole days", () => {
    expect(computeDragDays({ dx: DAY_WIDTH * 2, dayWidth: DAY_WIDTH })).toBe(2);
    expect(computeDragDays({ dx: -DAY_WIDTH * 3, dayWidth: DAY_WIDTH })).toBe(-3);
  });

  it("rounds to the nearest day and treats a sub-half-day nudge as a no-op", () => {
    expect(computeDragDays({ dx: DAY_WIDTH * 0.49, dayWidth: DAY_WIDTH })).toBe(0);
    expect(computeDragDays({ dx: DAY_WIDTH * 0.51, dayWidth: DAY_WIDTH })).toBe(1);
    expect(computeDragDays({ dx: 10, dayWidth: DAY_WIDTH })).toBe(0);
    expect(computeDragDays({ dx: -10, dayWidth: DAY_WIDTH })).toBe(0);
    expect(computeDragDays({ dx: 0, dayWidth: DAY_WIDTH })).toBe(0);
  });

  it("folds auto-scroll into the day count", () => {
    // Pointer never moved, but the canvas scrolled three days: the drop must
    // land three days further, not on the start day.
    expect(
      computeDragDays({ dx: 0, scrollDelta: DAY_WIDTH * 3, dayWidth: DAY_WIDTH })
    ).toBe(3);
    expect(
      computeDragDays({ dx: DAY_WIDTH, scrollDelta: -DAY_WIDTH * 2, dayWidth: DAY_WIDTH })
    ).toBe(-1);
  });

  it("is safe for a non-positive day width", () => {
    expect(computeDragDays({ dx: 100, dayWidth: 0 })).toBe(0);
  });
});

describe("applyMoveDays", () => {
  it("shifts both bounds when both exist", () => {
    const fields = applyMoveDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-12" }),
      3
    );
    expect(fields).toEqual({ start_date: "2026-09-13", due_date: "2026-09-15" });
  });

  it("shifts only the start when the task has no due date", () => {
    const fields = applyMoveDays(makeTask({ start_date: "2026-09-10" }), -2);
    expect(fields).toEqual({ start_date: "2026-09-08" });
  });

  it("shifts only the due when the task has no start date", () => {
    const fields = applyMoveDays(makeTask({ due_date: "2026-09-10" }), 5);
    expect(fields).toEqual({ due_date: "2026-09-15" });
  });

  it("assigns both dates to an undated task anchored on today", () => {
    const fields = applyMoveDays(makeTask(), 4, TODAY);
    expect(fields).toEqual({ start_date: "2026-09-20", due_date: "2026-09-20" });
  });
});

describe("applyResizeDays", () => {
  it("moves the start and keeps the due with a left resize", () => {
    const fields = applyResizeDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
      5,
      "left"
    );
    expect(fields).toEqual({ start_date: "2026-09-15", due_date: "2026-09-20" });
  });

  it("moves the due and keeps the start with a right resize", () => {
    const fields = applyResizeDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
      5,
      "right"
    );
    expect(fields).toEqual({ start_date: "2026-09-10", due_date: "2026-09-25" });
  });

  it("grows a start-only task to the right without moving its start", () => {
    const fields = applyResizeDays(makeTask({ start_date: "2026-09-10" }), 4, "right");
    expect(fields).toEqual({ start_date: "2026-09-10", due_date: "2026-09-14" });
  });

  it("grows a start-only task to the left without moving its anchor", () => {
    const fields = applyResizeDays(makeTask({ start_date: "2026-09-10" }), -2, "left");
    expect(fields).toEqual({ start_date: "2026-09-08", due_date: "2026-09-10" });
  });

  it("grows a due-only task to the left without moving its due", () => {
    const fields = applyResizeDays(makeTask({ due_date: "2026-09-10" }), -3, "left");
    expect(fields).toEqual({ start_date: "2026-09-07", due_date: "2026-09-10" });
  });

  it("grows a due-only task to the right without moving its due", () => {
    const fields = applyResizeDays(makeTask({ due_date: "2026-09-10" }), 4, "right");
    expect(fields).toEqual({ start_date: "2026-09-10", due_date: "2026-09-14" });
  });

  it("never inverts the bar when a resize crosses the other edge", () => {
    const fields = applyResizeDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
      -15,
      "right"
    );
    expect(fields).toEqual({ start_date: "2026-09-10", due_date: "2026-09-10" });
  });

  it("anchors an undated task on today", () => {
    expect(applyResizeDays(makeTask(), 2, "right", TODAY)).toEqual({
      start_date: "2026-09-16",
      due_date: "2026-09-18",
    });
  });
});

describe("resizePreviewRange", () => {
  it("moves the start bound for a left resize and keeps the due", () => {
    expect(
      resizePreviewRange(
        makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
        5,
        "left"
      )
    ).toEqual({ start: "2026-09-15", due: "2026-09-20" });
  });

  it("moves the due bound for a right resize and keeps the start", () => {
    expect(
      resizePreviewRange(
        makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
        5,
        "right"
      )
    ).toEqual({ start: "2026-09-10", due: "2026-09-25" });
  });

  it("fills the missing bound for a start-only or due-only task", () => {
    expect(resizePreviewRange(makeTask({ start_date: "2026-09-10" }), 4, "right")).toEqual({
      start: "2026-09-10",
      due: "2026-09-14",
    });
    expect(resizePreviewRange(makeTask({ due_date: "2026-09-10" }), -3, "left")).toEqual({
      start: "2026-09-07",
      due: "2026-09-10",
    });
  });

  it("returns null when the task has no date to anchor on", () => {
    expect(resizePreviewRange(makeTask(), 3, "left")).toBeNull();
  });
});

describe("taskSpanDays", () => {
  it("counts both bounds inclusively", () => {
    expect(
      taskSpanDays(makeTask({ start_date: "2026-09-10", due_date: "2026-09-12" }))
    ).toBe(3);
  });

  it("treats a single dated task as one day", () => {
    expect(taskSpanDays(makeTask({ start_date: "2026-09-10" }))).toBe(1);
    expect(taskSpanDays(makeTask({ due_date: "2026-09-10" }))).toBe(1);
  });

  it("uses the anchor day for an undated task", () => {
    expect(taskSpanDays(makeTask())).toBe(1);
  });
});

describe("resizePreviewSpan", () => {
  it("grows the span on a right resize without moving the left edge", () => {
    expect(resizePreviewSpan(3, 2, "right")).toEqual({ spanDays: 5, leftShiftDays: 0 });
  });

  it("shrinks but never collapses a right resize below one day", () => {
    expect(resizePreviewSpan(3, -5, "right")).toEqual({ spanDays: 1, leftShiftDays: 0 });
  });

  it("grows a left resize by moving the left edge without changing the due", () => {
    // span 3, drag the left edge two days left: span 5, leftShiftDays -2.
    expect(resizePreviewSpan(3, -2, "left")).toEqual({ spanDays: 5, leftShiftDays: -2 });
  });

  it("shrinks a left resize and clamps so the span stays at least one day", () => {
    expect(resizePreviewSpan(3, 5, "left")).toEqual({ spanDays: 1, leftShiftDays: 2 });
  });
});

describe("daysBetween", () => {
  it("counts whole days forward and backward between two ISO dates", () => {
    expect(daysBetween("2026-10-12", "2026-10-15")).toBe(3);
    expect(daysBetween("2026-10-15", "2026-10-12")).toBe(-3);
    expect(daysBetween("2026-10-14", "2026-10-14")).toBe(0);
  });

  it("returns null when either date is missing or unparseable", () => {
    expect(daysBetween(null, "2026-10-15")).toBeNull();
    expect(daysBetween("2026-10-12", undefined)).toBeNull();
    expect(daysBetween("nope", "2026-10-15")).toBeNull();
  });
});
