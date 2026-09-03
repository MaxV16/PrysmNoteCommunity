import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KanbanToolbar } from "./KanbanToolbar";

describe("KanbanToolbar", () => {
  const onScrollDirectionChange = vi.fn();
  const onCardLayoutChange = vi.fn();
  const onAddSection = vi.fn();

  beforeEach(() => {
    onScrollDirectionChange.mockClear();
    onCardLayoutChange.mockClear();
    onAddSection.mockClear();
  });

  function renderToolbar(props = {}) {
    return render(
      <KanbanToolbar
        scrollDirection="horizontal"
        cardLayout="stacked"
        onScrollDirectionChange={onScrollDirectionChange}
        onCardLayoutChange={onCardLayoutChange}
        onAddSection={onAddSection}
        {...props}
      />
    );
  }

  it("toggles the scroll direction", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("scroll-vertical"));
    expect(onScrollDirectionChange).toHaveBeenCalledWith("vertical");
    fireEvent.click(screen.getByTestId("scroll-horizontal"));
    expect(onScrollDirectionChange).toHaveBeenCalledWith("horizontal");
  });

  it("toggles the card layout", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("layout-side-by-side"));
    expect(onCardLayoutChange).toHaveBeenCalledWith("side_by_side");
    fireEvent.click(screen.getByTestId("layout-stacked"));
    expect(onCardLayoutChange).toHaveBeenCalledWith("stacked");
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
