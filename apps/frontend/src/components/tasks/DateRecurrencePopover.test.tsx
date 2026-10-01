import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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

afterEach(() => {
  document.body.className = "";
  setViewportWidth(1024);
});

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
}

/** Anchor whose rect can move, to simulate a window resize / drawer reflow. */
function makeTrigger(initial: { left: number; top: number }) {
  const el = document.createElement("button");
  document.body.appendChild(el);
  let rect = {
    ...initial,
    right: initial.left + 50,
    bottom: initial.top + 20,
    width: 50,
    height: 20,
  };
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
  const set = (next: { left: number; top: number }) => {
    rect = { ...next, right: next.left + 50, bottom: next.top + 20, width: 50, height: 20 };
  };
  return { ref: { current: el as HTMLElement | null }, moveTo: set };
}

function renderPopover(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <DateRecurrencePopover
      open
      triggerRef={{ current: null }}
      onClose={onClose}
      startDate={null}
      dueDate={null}
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

    expect(onChange).toHaveBeenCalledWith(today, today, "FREQ=DAILY", null);
  });

  it("sends a null date when clearing the reminder", () => {
    const { onChange } = renderPopover();

    fireEvent.click(screen.getByText("Clear"));
    fireEvent.click(screen.getByText("OK"));

    expect(onChange).toHaveBeenCalledWith(null, null, null, null);
  });

  it("re-anchors on window resize instead of floating detached", async () => {
    const trigger = makeTrigger({ left: 600, top: 100 });
    renderPopover({ triggerRef: trigger.ref });

    const popover = screen.getByRole("dialog");
    await waitFor(() => expect(popover.style.left).toBe("600px"));

    trigger.moveTo({ left: 120, top: 40 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(popover.style.left).toBe("120px");
      expect(popover.style.top).toBe("66px");
    });
  });

  it("never renders over the desktop window controls", () => {
    document.body.classList.add("desktop-shell");

    renderPopover();

    // No usable anchor + desktop shell: fall back to the top-left, but below
    // the reserved strip (38) so the traffic lights / button cluster stay clear.
    expect(screen.getByRole("dialog").style.top).toBe("50px");
  });

  it("renders nothing while closed", () => {
    // Regression: the always-on portal used to leave the card floating over the
    // task drawer even when the user never opened it.
    renderPopover({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("becomes a bottom sheet on a phone-width viewport", async () => {
    setViewportWidth(375);
    renderPopover();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("bottom-0");
    expect(dialog.className).toContain("rounded-t-2xl");
    // The anchored card's inline position must not apply to the sheet.
    expect(dialog.style.left).toBe("");

    act(() => {
      setViewportWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBeNull());
  });
});
