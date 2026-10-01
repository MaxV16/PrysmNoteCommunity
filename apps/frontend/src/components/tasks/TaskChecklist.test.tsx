import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskChecklist } from "./TaskChecklist";
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
