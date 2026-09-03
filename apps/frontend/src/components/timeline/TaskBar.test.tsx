import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TaskBar } from "./TaskBar";
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
    start_date: "2026-08-03",
    due_date: "2026-08-03",
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

describe("TaskBar", () => {
  it("renders a task bar with hidden overflow and no shrink below content", () => {
    const task = makeTask({
      title: "A very long task title that should ellipsize " + "x".repeat(200),
    });
    const { container } = render(
      <DndContext>
        <TaskBar task={task} style={{ left: 0, top: 0, width: 100 }} />
      </DndContext>
    );
    const bar = container.querySelector("[data-task-bar]") as HTMLElement | null;
    expect(bar).not.toBeNull();
    // Long titles must ellipsize inside the fixed-width bar, never bleed out.
    expect(bar!.style.overflow).toBe("hidden");
    // jsdom reports unit-less zeros as "0"; browsers normalize to "0px".
    expect(["0", "0px"]).toContain(bar!.style.minWidth);

    // The title span carries the truncate class so text-overflow engages.
    const titleSpan = Array.from(bar!.querySelectorAll("span")).find(
      (s) => s.textContent === task.title
    );
    expect(titleSpan).toBeDefined();
    expect(titleSpan!.className).toContain("truncate");
  });

  it("marks done tasks semi-transparent", () => {
    const task = makeTask({ status: "done", title: "Finished" });
    const { container } = render(
      <DndContext>
        <TaskBar task={task} style={{ left: 0, top: 0, width: 100 }} />
      </DndContext>
    );
    const bar = container.querySelector("[data-task-bar]") as HTMLElement;
    expect(bar.style.opacity).toBe("0.5");
  });
});
