import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ListView } from "./ListView";
import type { Task } from "@/types/task";

const h = vi.hoisted(() => ({
  setSelectedTaskId: vi.fn(),
  selectedTaskIds: [] as string[],
  setSelectedTaskIds: vi.fn(),
  toggleTaskSelected: vi.fn(),
  clearTaskSelection: vi.fn(),
  fetchTasks: vi.fn().mockResolvedValue(undefined),
  updateTask: vi.fn().mockResolvedValue(undefined),
  createTask: vi.fn(),
  tasks: [] as Task[],
}));

vi.mock("@/stores/app-store", () => {
  const appStore = (selector?: (s: unknown) => unknown) => {
    const state = {
      tasks: h.tasks,
      selectedTaskIds: h.selectedTaskIds,
      setSelectedTaskId: h.setSelectedTaskId,
      setSelectedTaskIds: h.setSelectedTaskIds,
      toggleTaskSelected: h.toggleTaskSelected,
      clearTaskSelection: h.clearTaskSelection,
      searchQuery: "",
      setSearchQuery: vi.fn(),
    };
    return selector ? selector(state) : state;
  };
  appStore.getState = () => ({
    tasks: h.tasks,
    selectedTaskIds: h.selectedTaskIds,
    setSelectedTaskId: h.setSelectedTaskId,
    setSelectedTaskIds: h.setSelectedTaskIds,
    toggleTaskSelected: h.toggleTaskSelected,
    clearTaskSelection: h.clearTaskSelection,
    searchQuery: "",
    setSearchQuery: vi.fn(),
  });
  return { useAppStore: appStore };
});

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    updateTask: h.updateTask,
    createTask: h.createTask,
    fetchTasks: h.fetchTasks,
    deleteTask: vi.fn(),
  }),
}));

vi.mock("@/hooks/useBoardSections", () => ({
  useBoardSections: () => ({ sections: [], loading: false, reload: vi.fn(), addSection: vi.fn() }),
}));

vi.mock("@/lib/use-local-bool", () => ({
  useLocalBool: () => false,
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({}), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

function makeTask(id: string, title: string): Task {
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
    start_date: null,
    due_date: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("ListView multi-select", () => {
  beforeEach(() => {
    h.tasks = [makeTask("t1", "Alpha"), makeTask("t2", "Beta")];
    h.selectedTaskIds = [];
    h.setSelectedTaskIds.mockClear();
    h.clearTaskSelection.mockClear();
    h.toggleTaskSelected.mockClear();
  });

  it("shows the batch toolbar when tasks are selected", () => {
    h.selectedTaskIds = ["t1", "t2"];
    render(<ListView />);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move to…/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set date/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Clear$/ })).toBeInTheDocument();
  });

  it("select-all posts the union of visible task ids", () => {
    render(<ListView />);
    fireEvent.click(screen.getByRole("button", { name: /Select all visible tasks/ }));
    expect(h.setSelectedTaskIds).toHaveBeenCalledWith(["t1", "t2"]);
  });

  it("clear empties the selection", () => {
    h.selectedTaskIds = ["t1"];
    render(<ListView />);
    fireEvent.click(screen.getByRole("button", { name: /^Clear$/ }));
    expect(h.clearTaskSelection).toHaveBeenCalled();
  });

  it("row meta-click toggles selection without opening the drawer", () => {
    render(<ListView />);
    fireEvent.click(screen.getAllByText("Alpha")[0], { metaKey: true });
    expect(h.toggleTaskSelected).toHaveBeenCalledWith("t1");
    expect(h.setSelectedTaskId).not.toHaveBeenCalled();
  });
});