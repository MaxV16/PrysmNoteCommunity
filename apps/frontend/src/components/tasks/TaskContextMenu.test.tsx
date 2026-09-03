import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskContextMenu } from "./TaskContextMenu";

const mocks = vi.hoisted(() => {
  const state: { selectedTaskId: string | null; setSelectedTaskId: (id: string | null) => void } = {
    selectedTaskId: null,
    setSelectedTaskId: vi.fn(),
  };
  const useAppStore = ((selector: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as never;
  (useAppStore as unknown as { getState: () => typeof state }).getState = () => state;
  return {
    createTask: vi.fn().mockResolvedValue({ id: "new" }),
    updateTask: vi.fn().mockResolvedValue({}),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue(undefined),
    addNoteWithContent: vi.fn(),
    openNotesWindow: vi.fn(),
    useUiModule: vi.fn(() => true),
    useAppStore,
  };
});

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: [],
    fetchTasks: mocks.fetchTasks,
    createTask: mocks.createTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
  }),
}));

vi.mock("@/components/sticky/StickyNoteBoard", () => ({
  useStickyBoard: () => ({ addNoteWithContent: mocks.addNoteWithContent }),
}));

vi.mock("@/stores/app-store", () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock("@/lib/ui-module-registry", () => ({
  useUiModule: mocks.useUiModule,
}));

vi.mock("@/lib/use-local-bool", () => ({
  useLocalBool: () => false,
}));

vi.mock("@/lib/notes", () => ({
  openNotesWindow: mocks.openNotesWindow,
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const task = {
  id: "t1",
  title: "My task",
  description: "desc",
  status: "todo",
  priority: 2,
  start_date: null,
  due_date: null,
  estimated_minutes: null,
  tags: [{ id: "tag1", name: "work", color: "#f00" }],
} as never;

describe("TaskContextMenu - task menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useUiModule.mockReturnValue(true);
  });

  function renderTaskMenu() {
    const onClose = vi.fn();
    const onNewTask = vi.fn();
    render(
      <TaskContextMenu menu={{ kind: "task", task }} onClose={onClose} onNewTask={onNewTask} />
    );
    return { onClose, onNewTask };
  }

  it("renders the full task menu item set", () => {
    renderTaskMenu();
    expect(screen.getByText("Edit task")).toBeInTheDocument();
    expect(screen.getByText("Mark complete")).toBeInTheDocument();
    expect(screen.getByText("Duplicate")).toBeInTheDocument();
    expect(screen.getByText("Add as sticky note")).toBeInTheDocument();
    expect(screen.getByText("Break down into subtasks (AI)")).toBeInTheDocument();
    expect(screen.getByText("Delete task")).toBeInTheDocument();
  });

  it("duplicate calls createTask with the clone payload", () => {
    renderTaskMenu();
    fireEvent.click(screen.getByText("Duplicate"));
    expect(mocks.createTask).toHaveBeenCalledWith({
      title: "My task",
      description: "desc",
      start_date: null,
      due_date: null,
      priority: 2,
      estimated_minutes: null,
      tag_ids: ["tag1"],
    });
  });

  it("delete requires a second confirm click before deleteTask fires", () => {
    renderTaskMenu();
    fireEvent.click(screen.getByText("Delete task"));
    expect(mocks.deleteTask).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm delete")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Confirm delete"));
    expect(mocks.deleteTask).toHaveBeenCalledWith("t1");
  });

  it("hides Add as sticky note when the stickyNotes module is off", () => {
    mocks.useUiModule.mockReturnValue(false);
    renderTaskMenu();
    expect(screen.queryByText("Add as sticky note")).not.toBeInTheDocument();
  });

  it("adds the task as a sticky note when clicked", () => {
    renderTaskMenu();
    fireEvent.click(screen.getByText("Add as sticky note"));
    expect(mocks.addNoteWithContent).toHaveBeenCalledWith("My task", "desc");
  });
});

describe("TaskContextMenu - empty-area menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels a day-scoped New task and forwards the day", () => {
    const onNewTask = vi.fn();
    render(
      <TaskContextMenu menu={{ kind: "empty", day: "2026-08-15" }} onClose={vi.fn()} onNewTask={onNewTask} />
    );
    const item = screen.getByText(/New task/);
    expect(item.textContent).toContain("15/08");
    fireEvent.click(item);
    expect(onNewTask).toHaveBeenCalledWith({ day: "2026-08-15" });
  });

  it("labels a section-scoped New task and forwards the section", () => {
    const onNewTask = vi.fn();
    render(
      <TaskContextMenu
        menu={{ kind: "empty", section: { id: "sec-1", title: "In Progress" } }}
        onClose={vi.fn()}
        onNewTask={onNewTask}
      />
    );
    fireEvent.click(screen.getByText(/New task in In Progress/));
    expect(onNewTask).toHaveBeenCalledWith({ section: { id: "sec-1", title: "In Progress" } });
  });

  it("New note opens the notes window", () => {
    render(
      <TaskContextMenu menu={{ kind: "empty" }} onClose={vi.fn()} onNewTask={vi.fn()} />
    );
    fireEvent.click(screen.getByText("New note"));
    expect(mocks.openNotesWindow).toHaveBeenCalled();
  });
});
