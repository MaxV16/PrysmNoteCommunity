import { describe, it, expect } from "vitest";
import { computeLaneLayout } from "./lane-layout";
import { BAR_HEIGHT, BAR_GAP, TOP_PADDING, SECTION_BOTTOM_PADDING } from "./constants";
import type { Task } from "@/types/task";

function makeTask(partial: Partial<Task>): Task {
  return {
    id: partial.id || crypto.randomUUID(),
    user_id: "u1",
    parent_task_id: null,
    title: partial.title || "Task",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    tags: [],
    links: [],
    subtasks: [],
    ...partial,
  };
}

function daysFor(start: string, count: number): Date[] {
  const d = new Date(start + "T00:00:00");
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

describe("computeLaneLayout", () => {
  const days = daysFor("2026-08-03", 3);

  it("returns a single-row height for one task", () => {
    const tasks = [makeTask({ id: "t1", start_date: "2026-08-03", due_date: "2026-08-03" })];
    const { positioned, maxStack, height } = computeLaneLayout(tasks, days);
    expect(positioned).toHaveLength(1);
    expect(maxStack).toBe(1);
    expect(height).toBe(
      TOP_PADDING * 2 + (BAR_HEIGHT + BAR_GAP) - BAR_GAP + SECTION_BOTTOM_PADDING
    );
  });

  it("grows the height with the busiest day's stack", () => {
    const tasks = [
      makeTask({ id: "t1", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t2", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t3", start_date: "2026-08-03", due_date: "2026-08-03" }),
    ];
    const { maxStack, height } = computeLaneLayout(tasks, days);
    expect(maxStack).toBe(3);
    expect(height).toBe(TOP_PADDING * 2 + 3 * (BAR_HEIGHT + BAR_GAP) - BAR_GAP + SECTION_BOTTOM_PADDING);
  });

  it("is deterministic and independent of input order", () => {
    const a = makeTask({ id: "a", title: "Alpha", start_date: "2026-08-03", due_date: "2026-08-03" });
    const b = makeTask({ id: "b", title: "Beta", start_date: "2026-08-03", due_date: "2026-08-03" });
    const first = computeLaneLayout([a, b], days).positioned.map((p) => p.task.id);
    const second = computeLaneLayout([b, a], days).positioned.map((p) => p.task.id);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(first);
  });

  it("excludes tasks outside the rendered range but pins undated ones", () => {
    const tasks = [
      makeTask({ id: "far", start_date: "2032-03-01", due_date: "2032-03-01" }),
      makeTask({ id: "undated", start_date: null, due_date: null }),
    ];
    const { positioned } = computeLaneLayout(tasks, days);
    expect(positioned.map((p) => p.task.id)).toEqual(["undated"]);
  });

  // Regression: a long-running task used to vanish once the rendered slice
  // scrolled past its start date, because the span test required containment
  // instead of overlap. Only single-day tasks survived.
  it("keeps a year-long task visible while the slice moves through its middle", () => {
    const long = makeTask({
      id: "long",
      start_date: "2026-01-01",
      due_date: "2026-12-31",
    });
    const oneDay = makeTask({ id: "one", start_date: "2026-09-16", due_date: "2026-09-16" });

    // Slice entirely inside the long task, months after its start date.
    const inside = daysFor("2026-09-10", 14);
    const inner = computeLaneLayout([long, oneDay], inside);
    expect(inner.positioned.map((p) => p.task.id).sort()).toEqual(["long", "one"]);
    const longPos = inner.positioned.find((p) => p.task.id === "long")!;
    // Clamped to the rendered window, never negative or past its width.
    expect(longPos.pos.left).toBe("0%");
    expect(longPos.pos.width).toBe("100%");

    // Scroll later: the start is far behind, the end is still ahead.
    const later = daysFor("2026-11-01", 14);
    const laterLayout = computeLaneLayout([long, oneDay], later);
    expect(laterLayout.positioned.map((p) => p.task.id)).toEqual(["long"]);

    // Past the end of the long task it drops out again.
    const after = daysFor("2027-02-01", 14);
    expect(computeLaneLayout([long, oneDay], after).positioned).toHaveLength(0);
  });

  it("clamps a bar that starts before and ends after the slice", () => {
    const spanning = makeTask({
      id: "span",
      start_date: "2020-01-01",
      due_date: "2030-01-01",
    });
    const slice = daysFor("2026-09-10", 10);
    const { positioned } = computeLaneLayout([spanning], slice);
    expect(positioned).toHaveLength(1);
    expect(positioned[0].pos.left).toBe("0%");
    expect(positioned[0].pos.width).toBe("100%");
  });

  it("keeps a partially overlapping bar anchored to the correct leading columns", () => {
    const task = makeTask({ id: "tail", start_date: "2026-09-01", due_date: "2026-09-12" });
    const slice = daysFor("2026-09-10", 10); // task's last 3 days are inside
    const { positioned } = computeLaneLayout([task], slice);
    expect(positioned).toHaveLength(1);
    expect(positioned[0].pos.left).toBe("0%");
    expect(positioned[0].pos.width).toBe("30%"); // Sep 10, 11, 12
  });

  it("keeps row assignment stable while the slice slides", () => {
    const tasks = [
      makeTask({ id: "long", start_date: "2026-01-01", due_date: "2026-12-31" }),
      makeTask({ id: "a", start_date: "2026-09-16", due_date: "2026-09-16" }),
      makeTask({ id: "b", start_date: "2026-09-17", due_date: "2026-09-17" }),
    ];
    const rowFor = (start: string) => {
      const positioned = computeLaneLayout(tasks, daysFor(start, 20)).positioned;
      return Object.fromEntries(positioned.map((p) => [p.task.id, p.pos.top]));
    };
    // Two adjacent slices covering the same tasks must agree on their rows.
    expect(rowFor("2026-09-10")).toEqual(rowFor("2026-09-11"));
  });

  it("still reserves bottom padding when no days are rendered", () => {
    const { height } = computeLaneLayout([], []);
    expect(height).toBe(TOP_PADDING * 2 + SECTION_BOTTOM_PADDING);
  });

  it("reserves section bottom padding below the last bar", () => {
    const bar = makeTask({ id: "t1", start_date: "2026-08-03", due_date: "2026-08-03" });
    const barHeight = TOP_PADDING * 2 + (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
    // One extra row of space sits below the bar for an easy create/drop target.
    expect(computeLaneLayout([bar], days).height).toBe(barHeight + SECTION_BOTTOM_PADDING);
    expect(SECTION_BOTTOM_PADDING).toBeGreaterThan(0);
  });
});
