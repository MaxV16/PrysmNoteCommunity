import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateRecurrencePopover } from "./DateRecurrencePopover";

const today = new Date().toISOString().split("T")[0];

beforeAll(() => {
  // jsdom may not provide rAF; the popover uses it only to re-position.
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function renderPopover(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <DateRecurrencePopover
      open
      triggerRef={{ current: null }}
      onClose={onClose}
      value={null}
      recurrenceRule={null}
      recurrenceEndDate={null}
      onChange={onChange}
      {...overrides}
    />
  );
  return { onChange, onClose };
}

describe("DateRecurrencePopover", () => {
  it("defaults the date to today when applying a repeat with no date picked", () => {
    const { onChange } = renderPopover();

    fireEvent.click(screen.getByText("Repeat"));
    fireEvent.click(screen.getByText("Daily"));
    fireEvent.click(screen.getByText("OK"));

    expect(onChange).toHaveBeenCalledWith(today, "FREQ=DAILY", null);
  });

  it("sends a null date when clearing the reminder", () => {
    const { onChange } = renderPopover();

    fireEvent.click(screen.getByText("Clear"));
    fireEvent.click(screen.getByText("OK"));

    expect(onChange).toHaveBeenCalledWith(null, null, null);
  });
});
