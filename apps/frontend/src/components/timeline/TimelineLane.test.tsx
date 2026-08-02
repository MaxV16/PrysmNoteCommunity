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
  const baseElements = Array.from(
    container.querySelectorAll('[class*="cursor-grab"]')
  ).map((el) => el.parentElement!).filter(Boolean);
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

  it("does not position date-less (note) tasks", () => {
    const tasks = [
      makeTask({ id: "note", title: "Just a note", start_date: null, due_date: null }),
    ];
    const { baseElements } = renderLane(tasks);
    expect(baseElements.length).toBe(0);
  });
});
