import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PriorityPicker } from "./PriorityPicker";

// The popover stays closed while the trigger reports a 0x0 rect, which is what
// jsdom returns for every element by default.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120,
    height: 32,
    top: 100,
    left: 20,
    right: 140,
    bottom: 132,
    x: 20,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PriorityPicker", () => {
  it("shows the current tier in the chip and keeps the menu closed", () => {
    render(<PriorityPicker value={2} onChange={vi.fn()} />);

    const trigger = screen.getByRole("combobox", { name: "Priority" });
    expect(trigger).toHaveTextContent("Priority");
    expect(trigger).toHaveTextContent("Medium");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens all three tiers, reports the pick, then closes after the feedback beat", async () => {
    const onChange = vi.fn();
    render(<PriorityPicker value={2} onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox", { name: "Priority" }));

    expect(screen.getByRole("listbox", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("option", { name: "Medium" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "High" }));

    expect(onChange).toHaveBeenCalledWith(1);
    await waitFor(
      () => expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
      { timeout: 1200 }
    );
  });

  it("uses the compact dot trigger in the drawer header", () => {
    render(<PriorityPicker variant="dot" value={3} onChange={vi.fn()} />);

    const trigger = screen.getByRole("combobox", { name: "Change priority" });
    expect(trigger).toHaveAttribute("title", "Priority: Low");

    fireEvent.click(trigger);

    expect(screen.getByRole("option", { name: "Low" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("closes on Escape without reporting a change", () => {
    const onChange = vi.fn();
    render(<PriorityPicker value={1} onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox", { name: "Priority" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
