import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("first", 180));
    expect(result.current).toBe("first");
  });

  it("publishes only the final value after the delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 180),
      { initialProps: { value: "a" } }
    );
    rerender({ value: "ab" });
    rerender({ value: "abc" });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(179);
    });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("abc");
  });

  it("cancels the pending update when the value returns to the current one", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 180),
      { initialProps: { value: "keep" } }
    );
    rerender({ value: "changed" });
    rerender({ value: "keep" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe("keep");
  });
});
