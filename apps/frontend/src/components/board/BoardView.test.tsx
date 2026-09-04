import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BoardView } from "./BoardView";
import type { Task } from "@/types/task";

const h = vi.hoisted(() => ({
  setSelectedTaskId: vi.fn(),
  setTasks: vi.fn(),
  updateTask: vi.fn().mockResolvedValue(undefined),
  fetchTasks: vi.fn().mockResolvedValue(undefined),
  tasks: [] as Task[],
  setPreference: vi.fn(),
}));

vi.mock("@/stores/app-store", () => {
  const appStore = (selector?: (s: unknown) => unknown) => {
    const state = {
      tasks: h.tasks,
      setSelectedTaskId: h.setSelectedTaskId,
      setTasks: h.setTasks,
      selectedTaskIds: [],
      setSelectedTaskIds: vi.fn(),
      toggleTaskSelected: vi.fn(),
      clearTaskSelection: vi.fn(),
    };
    return selector ? selector(state) : state;
  };
  appStore.getState = () => ({
    tasks: h.tasks,
    setSelectedTaskId: h.setSelectedTaskId,
    setTasks: h.setTasks,
    selectedTaskIds: [],
    setSelectedTaskIds: vi.fn(),
    toggleTaskSelected: vi.fn(),
    clearTaskSelection: vi.fn(),
  });
  return { useAppStore: appStore };
});

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    updateTask: h.updateTask,
    createTask: vi.fn(),
    fetchTasks: h.fetchTasks,
    deleteTask: vi.fn(),
  }),
}));

vi.mock("@/hooks/useBoardSections", () => ({
  useBoardSections: () => ({
    sections: h.sections,
    loading: false,
    reload: vi.fn(),
    addSection: vi.fn(),
    renameSection: vi.fn(),
    recolorSection: vi.fn(),
    removeSection: vi.fn(),
  }),
}));

vi.mock("@/stores/preferences-store", () => ({
  usePreferencesStore: (selector?: (s: unknown) => unknown) => {
    const state = { prefs: h.prefs, setPreference: h.setPreference, hydrate: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/lib/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/lib/sounds", () => ({
  playCompletionSound: vi.fn(),
}));

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: `Task ${id}`,
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
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("BoardView", () => {
  beforeEach(() => {
    h.setSelectedTaskId.mockClear();
    h.setTasks.mockClear();
    h.updateTask.mockClear();
    h.fetchTasks.mockClear();
    h.setPreference.mockClear();
    h.tasks = [];
    h.sections = [];
    h.prefs = {};
  });

  it("renders one card per top-level task, with subtasks only as checklist rows", () => {
    h.tasks = [
      makeTask("parent-1", { title: "Parent task" }),
      makeTask("child-1", { parent_task_id: "parent-1", title: "Child task" }),
    ];
    render(<BoardView tasks={[h.tasks[0]]} />);
    expect(screen.getAllByTestId("board-card")).toHaveLength(1);
    expect(screen.getByText("Parent task")).toBeInTheDocument();
    expect(screen.getByText("Child task")).toBeInTheDocument();
  });

  it("renders an empty state when no top-level tasks match", () => {
    render(<BoardView tasks={[]} />);
    expect(screen.getByText(/No tasks match this view yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a task/i })).toBeInTheDocument();
  });

  it("groups cards into sections and an Unsorted area", () => {
    h.sections = [
      { id: "sec-1", kind: "board", title: "Ideas", color: "#3d4a63", status: null, position: 0 },
    ];
    h.tasks = [
      makeTask("pinned-1", { title: "Pinned card", board_section_id: "sec-1" }),
      makeTask("loose-1", { title: "Unsorted card" }),
    ];
    render(<BoardView tasks={h.tasks} />);
    const groups = screen.getAllByTestId("board-group");
    expect(groups).toHaveLength(2); // Ideas + Unsorted
    expect(screen.getAllByTestId("board-masonry")).toHaveLength(2); // default prefs → masonry
    expect(screen.getByText("Pinned card")).toBeInTheDocument();
    expect(screen.getByText("Unsorted card")).toBeInTheDocument();
  });

  it("clicking a subtask checkbox calls updateTask with the toggled status", async () => {
    h.tasks = [
      makeTask("parent-1", { title: "Parent" }),
      makeTask("child-1", { parent_task_id: "parent-1", title: "Sub one" }),
    ];
    render(<BoardView tasks={[h.tasks[0]]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Mark Sub one done/ }));
    await waitFor(() => {
      expect(h.updateTask).toHaveBeenCalledWith("child-1", { status: "done" });
    });
    expect(h.setSelectedTaskId).not.toHaveBeenCalled();
  });

  it("clicking the card-level checkbox flips the task status", async () => {
    h.tasks = [makeTask("parent-1", { title: "Parent" })];
    render(<BoardView tasks={[h.tasks[0]]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Mark Parent done/ }));
    await waitFor(() => {
      expect(h.updateTask).toHaveBeenCalledWith("parent-1", { status: "done" });
    });
    expect(h.setSelectedTaskId).not.toHaveBeenCalled();
  });

  it("clicking the card body opens the task detail drawer", () => {
    h.tasks = [makeTask("parent-1", { title: "Click me" })];
    render(<BoardView tasks={[h.tasks[0]]} />);
    fireEvent.click(screen.getByText("Click me"));
    expect(h.setSelectedTaskId).toHaveBeenCalledWith("parent-1");
  });

  it("renders the completed-count footer", () => {
    h.tasks = [
      makeTask("parent-1", { title: "Parent" }),
      makeTask("child-1", { parent_task_id: "parent-1", title: "A", status: "done" }),
      makeTask("child-2", { parent_task_id: "parent-1", title: "B", status: "done" }),
      makeTask("child-3", { parent_task_id: "parent-1", title: "C" }),
    ];
    render(<BoardView tasks={[h.tasks[0]]} />);
    expect(screen.getByText("2 of 3 done")).toBeInTheDocument();
  });

  it("toolbar toggles persist per-board preferences", () => {
    render(<BoardView tasks={[]} />);
    fireEvent.click(screen.getByTestId("scroll-vertical"));
    expect(h.setPreference).toHaveBeenCalledWith("board_board_scroll_direction", "vertical");
    fireEvent.click(screen.getByTestId("layout-side-by-side"));
    expect(h.setPreference).toHaveBeenCalledWith("board_board_card_layout", "side_by_side");
  });

  it("adds a section from the toolbar", () => {
    render(<BoardView tasks={[]} />);
    fireEvent.click(screen.getByText("+ Add section"));
    fireEvent.change(screen.getByPlaceholderText("Section name"), { target: { value: "New section" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // useBoardSections.addSection is mocked; the section appears only after the
    // server round-trip, so just assert the toolbar flow completed without error.
    expect(screen.queryByPlaceholderText("Section name")).not.toBeInTheDocument();
  });
});
