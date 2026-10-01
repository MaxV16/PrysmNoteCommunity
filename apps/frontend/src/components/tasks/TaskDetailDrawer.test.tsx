import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import type { Task } from "@/types/task";

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn().mockResolvedValue(undefined),
  showToast: vi.fn(),
  addNoteWithContent: vi.fn(),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    updateTask: mocks.updateTask,
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    fetchTasks: vi.fn(),
  }),
}));
vi.mock("@/lib/toast-context", () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock("@/components/sticky/StickyNoteBoard", () => ({
  useStickyBoard: () => ({ addNoteWithContent: mocks.addNoteWithContent }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));

const baseTask = {
  id: "t1",
  title: "My task",
  description: "hello",
  status: "todo",
  priority: "none",
  tags: [],
  subtasks: [],
  links: [],
} as unknown as Task;

function renderDrawer(overrides: Partial<Task> = {}, onClose = vi.fn()) {
  render(<TaskDetailDrawer task={{ ...baseTask, ...overrides }} onClose={onClose} />);
  return { onClose };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("TaskDetailDrawer description editing", () => {
  it("opens the description editor with the formatting toolbar from the footer T", async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByRole("button", { name: "Edit description formatting" }));

    expect(screen.getByPlaceholderText("Write a description (markdown supported)…")).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bold" })).toBeTruthy();
  });

  it("inserts markdown into the description draft", async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(screen.getByRole("button", { name: "Edit description formatting" }));

    const textarea = screen.getByPlaceholderText(
      "Write a description (markdown supported)…"
    ) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);

    await user.click(screen.getByRole("button", { name: "Bold" }));

    expect(textarea.value).toBe("**hello**");
  });

  it("saves on an explicit Done button", async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(screen.getByRole("button", { name: "Edit description formatting" }));

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(mocks.updateTask).toHaveBeenCalledWith("t1", { description: "hello" });
  });

  it("reverts on Escape instead of closing the drawer", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();
    await user.click(screen.getByRole("button", { name: "Edit description formatting" }));

    const textarea = screen.getByPlaceholderText(
      "Write a description (markdown supported)…"
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "changed" } });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Write a description (markdown supported)…")).toBeNull();
  });

  it("renders description and subtasks together on one page (no tabs)", () => {
    renderDrawer({ description: "hello", subtasks: [{ id: "s1", title: "child" }] as Task[] });
    // Both sections render at once; there are no tab controls to switch between.
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getAllByText("Description").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Subtasks").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Description" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subtasks" })).toBeNull();
  });

  it("keeps the description editor open until the save resolves", async () => {
    let resolveSave: (() => void) | undefined;
    mocks.updateTask.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      })
    );
    const user = userEvent.setup();
    renderDrawer();
    await user.click(screen.getByRole("button", { name: "Edit description formatting" }));

    await user.click(screen.getByRole("button", { name: "Done" }));

    // The editor must NOT close (and flash the stale description) before the
    // save resolves; that is what made the new text look unsaved.
    expect(
      screen.getByPlaceholderText("Write a description (markdown supported)…")
    ).toBeTruthy();

    await act(async () => {
      resolveSave?.();
    });

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Write a description (markdown supported)…")
      ).toBeNull()
    );
  });
});

describe("TaskDetailDrawer footer comment button", () => {
  it("is disabled and never closes the drawer", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();

    const comments = screen.getByRole("button", { name: "Comments (coming soon)" }) as HTMLButtonElement;
    expect(comments.disabled).toBe(true);

    await user.click(comments);
    expect(onClose).not.toHaveBeenCalled();
  });
});
