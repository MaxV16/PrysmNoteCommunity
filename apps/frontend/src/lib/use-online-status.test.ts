import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useOnlineStatus } from "./use-online-status";

/**
 * Regression guard for React error #418 (hydration mismatch on every page).
 *
 * Node 22 defines a global `navigator` without `onLine`, so during SSR the
 * "is the browser online?" answer used to come back `undefined` (falsy) and the
 * offline banner was baked into every server-rendered page while the browser
 * rendered nothing. Unknown must mean online so server and client agree.
 */
function stubOnLine(value: boolean | undefined) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value as boolean);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOnlineStatus", () => {
  it("treats an unknown navigator.onLine (server-side Node navigator) as online", () => {
    stubOnLine(undefined);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("starts offline when the browser reports offline", () => {
    stubOnLine(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it("starts online when the browser reports online", () => {
    stubOnLine(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("follows online and offline events", async () => {
    stubOnLine(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    stubOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() => expect(result.current).toBe(false));

    stubOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current).toBe(true));
  });
});
