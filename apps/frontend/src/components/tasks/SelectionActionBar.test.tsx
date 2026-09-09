import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelectionActionBar } from "./SelectionActionBar";

describe("SelectionActionBar", () => {
  it("inline variant shows the count, delete and clear", () => {
    render(
      <SelectionActionBar count={3} onDelete={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Clear$/ })).toBeInTheDocument();
  });

  it("renders extra actions before delete", () => {
    render(
      <SelectionActionBar
        count={1}
        onDelete={vi.fn()}
        onClear={vi.fn()}
        extra={<button>Move to…</button>}
      />
    );
    expect(screen.getByRole("button", { name: /Move to…/ })).toBeInTheDocument();
  });

  it("floating variant renders a centered pill bar", () => {
    render(
      <SelectionActionBar floating count={2} onDelete={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.getByTestId("selection-action-bar")).toHaveClass("fixed");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
  });

  it("delete click fires the handler and busy disables it", () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <SelectionActionBar count={1} onDelete={onDelete} onClear={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalled();

    rerender(
      <SelectionActionBar count={1} busy onDelete={onDelete} onClear={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /Deleting…/ })).toBeDisabled();
  });
});