import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TaskBar } from "./TaskBar";
import { useAppStore } from "@/stores/app-store";
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
  beforeEach(() => {
    useAppStore.setState({ mobileActionTaskId: null });
  });

  it("renders a task bar with no shrink below content and a clipping label", () => {
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
    // The bar itself must NOT clip, otherwise the resize handles that sit just
    // outside its edges would be cut in half (bad touch targets).
    expect(bar!.style.overflow).toBe("visible");
    // jsdom reports unit-less zeros as "0"; browsers normalize to "0px".
    expect(["0", "0px"]).toContain(bar!.style.minWidth);

    // The label wrapper carries overflow-hidden + the title span carries
    // truncate so a long title still ellipsizes inside the fixed-width bar.
    const labelWrap = bar!.querySelector<HTMLElement>("div.overflow-hidden");
    expect(labelWrap).not.toBeNull();
    const titleSpan = Array.from(bar!.querySelectorAll("span")).find(
      (s) => s.textContent === task.title
    );
    expect(titleSpan).toBeDefined();
    expect(titleSpan!.className).toContain("truncate");
  });

  it("renders both resize handles and arms them when the task is long-pressed", () => {
    const task = makeTask({ title: "Resizable" });
    const { container } = render(
      <DndContext>
        <TaskBar task={task} style={{ left: 0, top: 0, width: 200 }} />
      </DndContext>
    );
    const left = container.querySelector('[data-resize-handle="left"]') as HTMLElement;
    const right = container.querySelector('[data-resize-handle="right"]') as HTMLElement;
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // Not armed: handles are revealed on hover (opacity-0 default + group hover).
    expect(left.className).toContain("opacity-0");

    // Once the task is armed via long-press, the handles stay visible and get a
    // touch-sized hit area.
    act(() => useAppStore.setState({ mobileActionTaskId: task.id }));
    const armed = render(
      <DndContext>
        <TaskBar task={task} style={{ left: 0, top: 0, width: 200 }} />
      </DndContext>
    );
    const armedLeft = armed.container.querySelector(
      '[data-resize-handle="left"]'
    ) as HTMLElement;
    expect(armedLeft.className).toContain("opacity-100");
    expect(armedLeft.style.width).toBe("24px");
  });

  it("marks done tasks semi-transparent", () => {
    const task = makeTask({ status: "done", title: "Finished" });
    const { container } = render(
      <DndContext>
        <TaskBar task={task} style={{ left: 0, top: 0, width: 100 }} />
      </DndContext>
    );
    const bar = container.querySelector("[data-task-bar]") as HTMLElement;
    expect(bar.style.opacity).toBe("0.65");
  });

  it("keeps the lane-provided width when no drag has happened", () => {
    // Regression: the drag engine's preview cleanup must not wipe the React-set
    // percent width on mount (that collapsed long bars so they never intersected
    // the viewport).
    const task = makeTask({ title: "Long span" });
    const { container } = render(
      <DndContext>
        <TaskBar task={task} style={{ left: "15%", top: 0, width: "85%" }} />
      </DndContext>
    );
    const bar = container.querySelector("[data-task-bar]") as HTMLElement;
    expect(bar.style.width).toBe("85%");
    expect(bar.style.transform).toBe("");
  });
});
