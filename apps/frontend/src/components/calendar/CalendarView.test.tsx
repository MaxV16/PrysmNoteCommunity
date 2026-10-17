import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CalendarView } from "./CalendarView";
import type { Task } from "@/types/task";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  fetchTasks: vi.fn(),
}));

vi.mock("@/hooks/useVisibleTasks", () => ({
  useVisibleTasks: () => mocks.tasks,
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ createTask: vi.fn(), fetchTasks: mocks.fetchTasks }),
}));

vi.mock("@/lib/toast-context", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const getMock = api.get as unknown as ReturnType<typeof vi.fn>;
const postMock = api.post as unknown as ReturnType<typeof vi.fn>;

function task(id: string, title: string, date: string): Task {
  return {
    id,
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title,
    description: null,
    status: "todo",
    priority: 2,
    start_date: date,
    due_date: null,
    start_time: null,
    end_time: null,
    is_all_day: true,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

function dateForDay(day: number): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

describe("CalendarView", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    mocks.fetchTasks.mockReset();
    getMock.mockResolvedValue({ connected: false, last_synced_at: null });
    postMock.mockResolvedValue({});
    useAppStore.setState({ selectedTaskId: null, selectedTaskIds: [] });
  });

  it("does not render a per-day add button", () => {
    const ds = dateForDay(10);
    mocks.tasks = [task("t0", "Task 0", ds)];

    render(<CalendarView />);

    expect(
      screen.queryByRole("button", { name: `Add task on ${ds}` })
    ).toBeNull();
    expect(document.querySelectorAll(`[data-cal-day="${ds}"]`)).toHaveLength(1);
  });

  it("expands a busy day by ten tasks at a time", () => {
    const ds = dateForDay(10);
    mocks.tasks = Array.from({ length: 5 }, (_, i) =>
      task(`t${i}`, `Task ${i}`, ds)
    );

    render(<CalendarView />);

    expect(screen.getByText("Task 0")).toBeTruthy();
    expect(screen.queryByText("Task 4")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: `Show more tasks on ${ds}` }));

    expect(screen.getByText("Task 4")).toBeTruthy();
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("drags a chip to another day and reschedules it", async () => {
    const from = dateForDay(10);
    const to = dateForDay(12);
    mocks.tasks = [task("drag", "Dragged task", from)];

    render(<CalendarView />);

    const chip = screen.getByText("Dragged task") as HTMLElement;
    const targetCell = document.querySelector(`[data-cal-day="${to}"]`) as HTMLElement;
    const fromCell = document.querySelector(`[data-cal-day="${from}"]`) as HTMLElement;
    expect(chip).toBeTruthy();
    expect(targetCell).toBeTruthy();
    expect(fromCell).toBeTruthy();

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetCell),
    });

    fireEvent.pointerDown(chip, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(chip, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerUp(chip, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 40,
      clientY: 40,
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/tasks/batch-reschedule", {
        task_ids: ["drag"],
        delta_days: 2,
      })
    );
    expect(mocks.fetchTasks).toHaveBeenCalled();
  });
});
