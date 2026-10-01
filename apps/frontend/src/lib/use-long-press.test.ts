import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLongPress } from "./use-long-press";

function pointerEvent(over: Record<string, unknown> = {}): React.PointerEvent {
  return {
    pointerType: "touch",
    clientX: 0,
    clientY: 0,
    target: document.body,
    preventDefault: vi.fn(),
    ...over,
  } as unknown as React.PointerEvent;
}

function dispatchClick(): boolean {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.body.dispatchEvent(click);
  return click.defaultPrevented;
}

describe("useLongPress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses the click that immediately follows a long-press", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    result.current.onPointerDown(pointerEvent());
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    result.current.onPointerUp(pointerEvent());
    expect(dispatchClick()).toBe(true);
  });

  it("does not swallow a later tap when the long-press produced no click", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    // Long-press fires, then the finger is lifted as part of a drag/pick-up:
    // no click follows, so the suppressor must expire.
    result.current.onPointerDown(pointerEvent());
    vi.advanceTimersByTime(500);
    result.current.onPointerUp(pointerEvent());
    vi.advanceTimersByTime(500);

    expect(dispatchClick()).toBe(false);
  });

  it("disarms immediately on pointercancel", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    result.current.onPointerDown(pointerEvent());
    vi.advanceTimersByTime(500);
    result.current.onPointerCancel();

    expect(dispatchClick()).toBe(false);
  });

  it("cancels the press when the pointer moves past the tolerance", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    result.current.onPointerDown(pointerEvent());
    result.current.onPointerMove(pointerEvent({ clientX: 40 }));
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(dispatchClick()).toBe(false);
  });
});
