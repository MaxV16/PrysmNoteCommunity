import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskForm } from "./TaskForm";

const useAppStore = vi.fn(() => ({ tags: [], lists: [], activeListId: null }));

// Mock app-store
vi.mock("@/stores/app-store", () => ({
  useAppStore: () => useAppStore(),
}));

beforeEach(() => {
  useAppStore.mockReturnValue({ tags: [], lists: [], activeListId: null });
});

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: "t1",
    title: "Edit me",
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    tags: [],
    ...overrides,
  };
}

describe("TaskForm", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };

  it("shows default 30 minutes for new tasks", () => {
    render(<TaskForm {...defaultProps} />);
    const minInput = screen.getByDisplayValue("30");
    expect(minInput).toBeInTheDocument();
  });

  it("does not set default 30 minutes when editing", () => {
    render(
      <TaskForm
        {...defaultProps}
        initial={{ id: "1", title: "Edit me", estimated_minutes: 45 } as any}
      />
    );
    expect(screen.getByDisplayValue("45")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("30")).not.toBeInTheDocument();
  });

  it("recurrence presets dropdown includes all options", () => {
    render(<TaskForm {...defaultProps} />);
    const selects = screen.getAllByRole("combobox");
    // The 4th select is the recurrence one (after list, status, priority)
    const recurrenceSelect = selects[3];
    expect(recurrenceSelect).toBeInTheDocument();
    const options = Array.from(recurrenceSelect.querySelectorAll("option"));
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain("None");
    expect(labels).toContain("Daily");
    expect(labels).toContain("Weekly");
    expect(labels).toContain("Custom");
  });

  it("submit calls onSubmit with title and default 30 minutes", () => {
    const onSubmit = vi.fn();
    render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "Test task" } });

    const submitBtn = screen.getByRole("button", { name: /create task/i });
    fireEvent.click(submitBtn);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test task",
        estimated_minutes: 30,
      })
    );
  });

  it("submit does nothing for empty title", () => {
    const onSubmit = vi.fn();
    render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: /create task/i });
    fireEvent.click(submitBtn);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("editing a task pre-selects its existing tags", () => {
    const onSubmit = vi.fn();
    render(
      <TaskForm
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initial={makeTask({ tags: [{ id: "tag-1", name: "urgent", color: "#ff0000" }] })}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Edit me" },
    });
    fireEvent.click(screen.getByRole("button", { name: /update task/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tag_ids: ["tag-1"] })
    );
  });

  it("submitting an edit passes pre-existing plus newly selected tags", () => {
    useAppStore.mockReturnValue({
      tags: [
        { id: "tag-1", name: "urgent", color: "#ff0000" },
        { id: "tag-2", name: "later", color: "#00ff00" },
      ],
      lists: [],
      activeListId: null,
    });
    const onSubmit = vi.fn();
    render(
      <TaskForm
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initial={makeTask({ tags: [{ id: "tag-1", name: "urgent", color: "#ff0000" }] })}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Edit me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "later" }));
    fireEvent.click(screen.getByRole("button", { name: /update task/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tag_ids: ["tag-1", "tag-2"] })
    );
  });

  it("blocks submit with an inline warning when end time is before start time", () => {
    const onSubmit = vi.fn();
    const { container } = render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Task" },
    });
    const timeInputs = container.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: "10:00" } });
    fireEvent.change(timeInputs[1], { target: { value: "09:00" } });

    expect(screen.getByText("End time must be after the start time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits when the same-day end time follows the start time", () => {
    const onSubmit = vi.fn();
    const { container } = render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Task" },
    });
    const timeInputs = container.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: "09:00" } });
    fireEvent.change(timeInputs[1], { target: { value: "10:00" } });

    expect(screen.queryByText("End time must be after the start time")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("blocks submit with an inline warning when the due date precedes the start date", () => {
    const onSubmit = vi.fn();
    render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Task" },
    });
    // Open the Start Date picker and pick day 10 of the current month.
    fireEvent.click(screen.getAllByText("Not set")[0]);
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    // The start button now shows its date; open the Due Date picker and pick
    // day 5, which precedes the start date.
    fireEvent.click(screen.getByText("Not set"));
    fireEvent.click(screen.getByRole("button", { name: "5" }));

    expect(screen.getByText("Due date cannot be before the start date")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
