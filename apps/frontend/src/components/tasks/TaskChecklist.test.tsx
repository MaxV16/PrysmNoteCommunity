import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskChecklist, sortSubtasks } from "./TaskChecklist";
import type { Task } from "@/types/task";

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn().mockResolvedValue(undefined),
  upload: vi.fn(),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ updateTask: mocks.updateTask, fetchTasks: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    upload: mocks.upload,
  },
}));

const sub = { id: "s1", title: "hello", status: "todo" } as unknown as Task;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function imageClipboard(name = "pasted.png"): DataTransfer {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  return {
    files: [file],
    items: [],
    getData: () => "",
  } as unknown as DataTransfer;
}

describe("TaskChecklist subtask formatting", () => {
  it("opens the formatter from the row button and saves markdown", async () => {
    const user = userEvent.setup();
    const { container } = render(<TaskChecklist subtasks={[sub]} taskId="t1" />);

    // The Format button must be reachable (it was `hidden` without a touch
    // override, so phones could never open the subtask formatter).
    await user.click(screen.getByRole("button", { name: "Format hello" }));

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();

    textarea.setSelectionRange(0, textarea.value.length);
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(textarea.value).toBe("**hello**");

    fireEvent.blur(textarea);

    await waitFor(() => expect(mocks.updateTask).toHaveBeenCalledWith("s1", { title: "**hello**" }));
    await waitFor(() => expect(container.querySelector("strong")).toBeTruthy());
  });

  it("keeps the formatter open while text inside it is selected", async () => {
    const user = userEvent.setup();
    const { container } = render(<TaskChecklist subtasks={[sub]} taskId="t1" />);

    await user.click(screen.getByRole("button", { name: "Format hello" }));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Double-click is how a user selects a word. It used to bubble to the row
    // and start a plain rename, which reset the draft and removed the toolbar.
    fireEvent.doubleClick(textarea);

    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    expect(container.querySelector("textarea")).toBe(textarea);
  });

  it("pastes an image into an existing subtask title and previews it", async () => {
    mocks.upload.mockResolvedValue({ url: "/api/uploads/pasted.png" });
    const user = userEvent.setup();
    const { container } = render(<TaskChecklist subtasks={[sub]} taskId="t1" />);

    await user.click(screen.getByRole("button", { name: "Format hello" }));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.paste(textarea, { clipboardData: imageClipboard() });

    await waitFor(() =>
      expect(textarea.value).toContain("![pasted](/api/uploads/pasted.png)")
    );
    expect(mocks.upload).toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Copy image: pasted" })
    ).toBeTruthy();
  });

  it("pastes an image into the add-subtask field", async () => {
    mocks.upload.mockResolvedValue({ url: "/api/uploads/new.png" });
    render(<TaskChecklist subtasks={[sub]} taskId="t1" />);

    const input = screen.getByPlaceholderText("Add subtask...") as HTMLInputElement;
    fireEvent.paste(input, { clipboardData: imageClipboard("new.png") });

    await waitFor(() =>
      expect(input.value).toBe("![new](/api/uploads/new.png)")
    );
  });
});

describe("sortSubtasks", () => {
  it("keeps open subtasks first and sinks completed ones to the bottom, stable within a group", () => {
    const open1 = { id: "o1", title: "open one", status: "todo" } as unknown as Task;
    const done1 = { id: "d1", title: "done one", status: "done" } as unknown as Task;
    const open2 = { id: "o2", title: "open two", status: "todo" } as unknown as Task;
    const done2 = { id: "d2", title: "done two", status: "done" } as unknown as Task;

    expect(sortSubtasks([done1, open1, done2, open2]).map((s) => s.id)).toEqual([
      "o1",
      "o2",
      "d1",
      "d2",
    ]);
  });
});

describe("TaskChecklist completed ordering", () => {
  it("hides a completed subtask and reveals it again under Show completed", async () => {
    const a = { id: "a", title: "alpha", status: "todo" } as unknown as Task;
    const b = { id: "b", title: "beta", status: "todo" } as unknown as Task;
    const { container } = render(<TaskChecklist subtasks={[a, b]} taskId="t1" />);

    const order = () =>
      Array.from(container.querySelectorAll('[role="checkbox"]')).map((el) => el.id);

    expect(order()).toEqual(["subtask-check-a", "subtask-check-b"]);

    fireEvent.click(container.querySelector("#subtask-check-a")!);

    // Completed subtasks are hidden by default, so only "b" stays visible.
    await waitFor(() => expect(order()).toEqual(["subtask-check-b"]));
    expect(mocks.updateTask).toHaveBeenCalledWith("a", { status: "done" });

    // The toggle counts the hidden ones and brings them back, done last.
    const toggle = await screen.findByRole("button", { name: /Show completed/i });
    expect(toggle.textContent).toContain("Show completed (1)");
    fireEvent.click(toggle);
    await waitFor(() => expect(order()).toEqual(["subtask-check-b", "subtask-check-a"]));
  });
});
