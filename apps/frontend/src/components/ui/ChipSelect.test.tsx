import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChipSelect } from "./ChipSelect";

const OPTIONS = [
  { value: "todo", label: "To Do" },
  { value: "done", label: "Done" },
];

// The menu positions itself from the trigger's rect (and stays closed while that
// rect is 0x0, which is what jsdom reports for every element).
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

describe("ChipSelect", () => {
  it("shows the caption and the current option, and keeps the list closed", () => {
    render(
      <ChipSelect label="Status" value="todo" options={OPTIONS} onChange={vi.fn()} />
    );

    const trigger = screen.getByRole("combobox", { name: "Status" });
    expect(trigger).toHaveTextContent("Status");
    expect(trigger).toHaveTextContent("To Do");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens a themed list and reports the picked option", () => {
    const onChange = vi.fn();
    render(
      <ChipSelect label="Status" value="todo" options={OPTIONS} onChange={onChange} />
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    expect(screen.getByRole("listbox", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "To Do" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(screen.getByRole("option", { name: "Done" }));

    expect(onChange).toHaveBeenCalledWith("done");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without changing the value", () => {
    const onChange = vi.fn();
    render(
      <ChipSelect label="Status" value="todo" options={OPTIONS} onChange={onChange} />
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
