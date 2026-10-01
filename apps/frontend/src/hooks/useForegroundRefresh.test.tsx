import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useForegroundRefresh } from "./useForegroundRefresh";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("useForegroundRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires when the window regains focus and de-dupes a rapid burst", () => {
    const cb = vi.fn();
    renderHook(() => useForegroundRefresh(cb, { intervalMs: 60000 }));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(cb).toHaveBeenCalledTimes(1);

    // A visibilitychange right behind the focus must not fire a second time.
    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("never fires while the document is hidden", () => {
    const cb = vi.fn();
    renderHook(() => useForegroundRefresh(cb, { intervalMs: 60000 }));

    setVisibility("hidden");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires on the bounded interval while visible", () => {
    const cb = vi.fn();
    renderHook(() => useForegroundRefresh(cb, { intervalMs: 60000 }));

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
