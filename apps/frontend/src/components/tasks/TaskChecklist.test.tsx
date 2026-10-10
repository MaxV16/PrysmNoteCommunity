import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskChecklist, sortSubtasks } from "./TaskChecklist";
import type { Task } from "@/types/task";

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ updateTask: mocks.updateTask, fetchTasks: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));

const sub = { id: "s1", title: "hello", status: "todo" } as unknown as Task;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
  it("moves a subtask to the bottom once it is checked off", async () => {
    const a = { id: "a", title: "alpha", status: "todo" } as unknown as Task;
    const b = { id: "b", title: "beta", status: "todo" } as unknown as Task;
    const { container } = render(<TaskChecklist subtasks={[a, b]} taskId="t1" />);

    const order = () =>
      Array.from(container.querySelectorAll('[role="checkbox"]')).map((el) => el.id);

    expect(order()).toEqual(["subtask-check-a", "subtask-check-b"]);

    fireEvent.click(container.querySelector("#subtask-check-a")!);

    await waitFor(() => expect(order()).toEqual(["subtask-check-b", "subtask-check-a"]));
    expect(mocks.updateTask).toHaveBeenCalledWith("a", { status: "done" });
  });
});
