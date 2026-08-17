import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskForm } from "./TaskForm";

// Mock app-store
vi.mock("@/stores/app-store", () => ({
  useAppStore: () => ({
    tags: [],
  }),
}));

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
    // The 3rd select is the recurrence one (after status, priority)
    const recurrenceSelect = selects[2];
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
});
