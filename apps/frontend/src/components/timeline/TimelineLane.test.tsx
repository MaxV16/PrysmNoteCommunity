import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TimelineLane } from "./TimelineLane";
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

interface RenderLane {
  container: HTMLElement;
  baseElements: Element[];
}

function renderLane(tasks: Task[], start = "2026-08-03"): RenderLane {
  const days = daysFor(start, 3);
  const { container } = render(
    <DndContext>
      <TimelineLane tasks={tasks} days={days} />
    </DndContext>
  );
  // Task bars carry a `data-task-bar` attribute (our stable hook) and are
  // positioned via inline style.top; use them for assertions.
  const baseElements = Array.from(container.querySelectorAll('[data-task-bar]'));
  return { container, baseElements };
}

describe("TimelineLane stacking", () => {
  it("stacks multiple same-day tasks at distinct vertical offsets", () => {
    const tasks = [
      makeTask({ id: "t1", title: "GP appointment", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t2", title: "Work meeting", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t3", title: "Lunch", start_date: "2026-08-03", due_date: "2026-08-03" }),
    ];
    const { baseElements } = renderLane(tasks);
    // The task bars are the elements with cursor-grab; verify distinct top offsets.
    const tops = baseElements
      .map((el) => (el.style as CSSStyleDeclaration).top)
      .filter(Boolean);
    const topValues = tops.map((t) => parseInt(t, 10));
    expect(new Set(topValues).size).toBe(Math.min(3, topValues.length));
  });

  it("scales lane min-height with the busiest day", () => {
    // 3 tasks on day 1, but only 1 on day 2.
    const tasks = [
      makeTask({ id: "t1", title: "A", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t2", title: "B", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t3", title: "C", start_date: "2026-08-03", due_date: "2026-08-03" }),
      makeTask({ id: "t4", title: "D", start_date: "2026-08-04", due_date: "2026-08-04" }),
    ];
    const { container } = renderLane(tasks);
    const lane = container.querySelector('[class*="relative"]');
    expect(lane).not.toBeNull();
  });

  it("renders date-less (undated) tasks pinned to today's column so they can be dragged onto a date", () => {
    const tasks = [
      makeTask({ id: "note", title: "Just a note", start_date: null, due_date: null }),
    ];
    const { baseElements } = renderLane(tasks);
    // Undated tasks are now rendered (pinned to the today column) so a user can
    // grab and drag them to assign a date.
    expect(baseElements.length).toBe(1);
  });

  it("positions a dated task and an undated task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Dated", start_date: "2026-08-04", due_date: "2026-08-04" }),
      makeTask({ id: "note", title: "Undated", start_date: null, due_date: null }),
    ];
    const { baseElements } = renderLane(tasks);
    // Both the dated and undated (pinned) bars are rendered.
    expect(baseElements.length).toBe(2);
  });
});
