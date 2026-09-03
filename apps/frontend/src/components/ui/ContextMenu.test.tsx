import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextMenu, ContextMenuItem, ContextMenuDivider } from "./ContextMenu";

function renderMenu(props = {}) {
  const onClose = vi.fn();
  const onItem = vi.fn();
  const utils = render(
    <ContextMenu open x={100} y={80} onClose={onClose} {...props}>
      <ContextMenuItem onClick={onItem}>Alpha</ContextMenuItem>
      <ContextMenuItem onClick={onItem}>Beta</ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem onClick={onItem} danger>
        Gamma
      </ContextMenuItem>
    </ContextMenu>
  );
  return { onClose, onItem, ...utils };
}

describe("ContextMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders items with role=menu when open", () => {
    renderMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("renders nothing when closed", () => {
    render(
      <ContextMenu open={false} x={0} y={0} onClose={vi.fn()}>
        <ContextMenuItem onClick={() => {}}>X</ContextMenuItem>
      </ContextMenu>
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("positions the menu at the pointer x/y", () => {
    renderMenu();
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("80px");
  });

  it("closes on Escape", () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a mousedown outside the menu", () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a mousedown inside the menu", () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(screen.getByText("Beta"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focuses the first item on open and cycles with arrow keys", () => {
    renderMenu();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    // Cycles back to the first item.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("activates the focused item with Enter", () => {
    const { onItem } = renderMenu();
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onItem).toHaveBeenCalled();
  });

  it("does not reset keyboard focus when onClose identity changes while open", () => {
    // Views pass inline `() => setMenu(null)` closures, so onClose gets a new
    // identity on every parent render. Re-rendering must not re-focus the first
    // item (which would jump focus away from the user's arrow navigation).
    const onClose = vi.fn();
    const { rerender } = render(
      <ContextMenu open x={100} y={80} onClose={onClose}>
        <ContextMenuItem onClick={() => {}}>Alpha</ContextMenuItem>
        <ContextMenuItem onClick={() => {}}>Beta</ContextMenuItem>
        <ContextMenuItem onClick={() => {}}>Gamma</ContextMenuItem>
      </ContextMenu>
    );
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    rerender(
      <ContextMenu open x={100} y={80} onClose={vi.fn()}>
        <ContextMenuItem onClick={() => {}}>Alpha</ContextMenuItem>
        <ContextMenuItem onClick={() => {}}>Beta</ContextMenuItem>
        <ContextMenuItem onClick={() => {}}>Gamma</ContextMenuItem>
      </ContextMenu>
    );
    expect(document.activeElement).toBe(items[1]);
  });

  it("activates an item on click", () => {
    const { onItem } = renderMenu();
    fireEvent.click(screen.getByText("Beta"));
    expect(onItem).toHaveBeenCalledTimes(1);
  });
});
