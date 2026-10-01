import { describe, expect, it } from "vitest";
import type { Task } from "@/types/task";
import {
  applyMoveDays,
  applyResizeDays,
  computeDragDays,
  dragOffsetPx,
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
  it("moves the start with a left resize", () => {
    const fields = applyResizeDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
      5,
      "left"
    );
    expect(fields).toEqual({ start_date: "2026-09-15" });
  });

  it("moves the due with a right resize", () => {
    const fields = applyResizeDays(
      makeTask({ start_date: "2026-09-10", due_date: "2026-09-20" }),
      5,
      "right"
    );
    expect(fields).toEqual({ due_date: "2026-09-25" });
  });

  it("resizes a start-only task from its start", () => {
    const right = applyResizeDays(makeTask({ start_date: "2026-09-10" }), 4, "right");
    expect(right).toEqual({ due_date: "2026-09-14" });
  });

  it("resizes a due-only task from its due", () => {
    const left = applyResizeDays(makeTask({ due_date: "2026-09-10" }), -3, "left");
    expect(left).toEqual({ start_date: "2026-09-07" });
  });

  it("anchors an undated task on today", () => {
    expect(applyResizeDays(makeTask(), 2, "left", TODAY)).toEqual({
      start_date: "2026-09-18",
    });
    expect(applyResizeDays(makeTask(), 2, "right", TODAY)).toEqual({
      due_date: "2026-09-18",
    });
  });
});
