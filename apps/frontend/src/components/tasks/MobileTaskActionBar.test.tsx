import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { MobileTaskActionBar } from "./MobileTaskActionBar";

const h = vi.hoisted(() => ({
  createTask: vi.fn().mockResolvedValue(undefined),
  updateTask: vi.fn().mockResolvedValue(undefined),
  softDelete: vi.fn().mockResolvedValue(true),
  post: vi.fn().mockResolvedValue({}),
  showToast: vi.fn(),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ createTask: h.createTask, updateTask: h.updateTask }),
}));
vi.mock("@/hooks/useBatchDelete", () => ({
  useBatchDelete: () => ({ softDeleteWithUndo: h.softDelete }),
}));
vi.mock("@/hooks/useBoardSections", () => ({
  useBoardSections: () => ({
    sections: [{ id: "s1", kind: "timeline", title: "Work", color: "#fff", status: null, position: 0 }],
  }),
}));
vi.mock("@/lib/api", () => ({ api: { post: h.post } }));
vi.mock("@/lib/toast-context", () => ({ useToast: () => ({ showToast: h.showToast }) }));

function makeTask(): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Long pressed task",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    start_time: null,
    end_time: null,
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
  };
}

describe("MobileTaskActionBar", () => {
  beforeEach(() => {
    h.createTask.mockClear();
    h.updateTask.mockClear();
    h.softDelete.mockClear();
    h.post.mockClear();
    h.showToast.mockClear();
    useAppStore.setState({ tasks: [], mobileActionTaskId: null });
  });

  it("renders nothing when no task is long-pressed", () => {
    const { container } = render(<MobileTaskActionBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the action bar and completes the task", async () => {
    const task = makeTask();
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    expect(screen.getByText("Long pressed task")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.updateTask).toHaveBeenCalledWith("t1", { status: "done" }));
    await waitFor(() => expect(useAppStore.getState().mobileActionTaskId).toBeNull());
  });

  it("deletes via the undo flow", async () => {
    const task = makeTask();
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.softDelete).toHaveBeenCalledWith(["t1"]));
  });

  it("moves the task to a date and section", async () => {
    const task = makeTask();
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.change(screen.getByLabelText(/Move to date/i), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText(/Section/i), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(h.updateTask).toHaveBeenCalledWith("t1", { start_date: "2026-10-01" }));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith("/tasks/board-move", {
        task_id: "t1",
        section_id: "s1",
        index: 0,
      })
    );
  });

  it("does not toast success or call the API when nothing changed", async () => {
    const task = makeTask();
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.getByText("Long pressed task")).toBeInTheDocument());
    expect(h.updateTask).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("clears a date by sending null for both date columns", async () => {
    const task = { ...makeTask(), start_date: "2026-10-01" };
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.change(screen.getByLabelText(/Move to date/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(h.updateTask).toHaveBeenCalledWith("t1", { start_date: null, due_date: null })
    );
  });

  it("stretches a task to span more days from the long-press menu", async () => {
    const task = { ...makeTask(), start_date: "2026-10-01", due_date: "2026-10-01" };
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Stretch" }));
    // Extend the end by one day, then apply.
    fireEvent.click(screen.getByRole("button", { name: "End one day later" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(h.updateTask).toHaveBeenCalledWith("t1", {
        start_date: "2026-10-01",
        due_date: "2026-10-02",
      })
    );
  });

  it("shrinks a task without letting the end pass the start", async () => {
    const task = { ...makeTask(), start_date: "2026-10-01", due_date: "2026-10-03" };
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Stretch" }));
    // Two shrinks would pass the start, so the end clamps to the start.
    fireEvent.click(screen.getByRole("button", { name: "End one day earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "End one day earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "End one day earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(h.updateTask).toHaveBeenCalledWith("t1", {
        start_date: "2026-10-01",
        due_date: "2026-10-01",
      })
    );
  });

  it("keeps move mode open when a background refresh changes task identity", async () => {
    const task = makeTask();
    useAppStore.setState({ tasks: [task], mobileActionTaskId: task.id });

    render(<MobileTaskActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByLabelText(/Move to date/i)).toBeInTheDocument();

    // mergeTasks replaces task objects on every refresh; the same task must not
    // reset the in-progress move flow.
    act(() => {
      useAppStore.setState({ tasks: [{ ...task }] });
    });

    expect(screen.getByLabelText(/Move to date/i)).toBeInTheDocument();
  });
});
