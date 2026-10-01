import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KanbanToolbar } from "./KanbanToolbar";

describe("KanbanToolbar", () => {
  const onAddSection = vi.fn();
  const onFilterChange = vi.fn();

  beforeEach(() => {
    onAddSection.mockClear();
    onFilterChange.mockClear();
  });

  function renderToolbar(props = {}) {
    return render(
      <KanbanToolbar
        onAddSection={onAddSection}
        filter="all"
        onFilterChange={onFilterChange}
        {...props}
      />
    );
  }

  it("changes the completion filter", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("board-filter-completed"));
    expect(onFilterChange).toHaveBeenCalledWith("completed");
    fireEvent.click(screen.getByTestId("board-filter-active"));
    expect(onFilterChange).toHaveBeenCalledWith("active");
  });

  it("hides the filter when no handler is provided", () => {
    renderToolbar({ onFilterChange: undefined });
    expect(screen.queryByTestId("board-filter-completed")).toBeNull();
  });

  it("adds a section with a trimmed title", () => {
    renderToolbar();
    fireEvent.click(screen.getByText("+ Add section"));
    const input = screen.getByPlaceholderText("Section name");
    fireEvent.change(input, { target: { value: "  Ideas  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAddSection).toHaveBeenCalledWith("Ideas");
  });

  it("ignores an empty section title", () => {
    renderToolbar();
    fireEvent.click(screen.getByText("+ Add section"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAddSection).not.toHaveBeenCalled();
  });
});
