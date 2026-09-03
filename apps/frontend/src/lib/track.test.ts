import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { track, trackSessionStart, __resetTrackStateForTests } from "./track";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("track", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTrackStateForTests();
    mockFetch.mockResolvedValue({ ok: true });
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is silent when the network fails (never throws, never redirects)", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    expect(() => track("signed_up")).not.toThrow();
    // The flush fires on a timer; it must swallow the rejection too.
    vi.advanceTimersByTime(6000);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("buffers and posts with CSRF header and credentials", async () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      configurable: true,
      value: "csrf_token=test-csrf-token",
    });
    track("task_created", { source: "quick" });
    vi.advanceTimersByTime(6000);
    await vi.advanceTimersByTimeAsync(1);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/analytics/track");
    expect(opts.method).toBe("POST");
    expect(opts.credentials).toBe("include");
    expect(opts.headers["X-CSRF-Token"]).toBe("test-csrf-token");
    const body = JSON.parse(opts.body);
    expect(body.event).toBe("task_created");
    expect(body.properties).toEqual({ source: "quick" });
    expect(typeof body.session_id).toBe("string");
  });

  it("creates a session id lazily and persists it", () => {
    expect(window.localStorage.getItem("prysm_session_id")).toBeNull();
    track("mic_pressed");
    const id = window.localStorage.getItem("prysm_session_id");
    expect(id).toBeTruthy();
    track("mic_pressed");
    expect(window.localStorage.getItem("prysm_session_id")).toBe(id);
  });

  it("trackSessionStart returns a stable id", () => {
    const a = trackSessionStart();
    const b = trackSessionStart();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("posts every buffered event, not just the first", async () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      configurable: true,
      value: "csrf_token=test-csrf-token",
    });
    track("mic_pressed");
    track("trial_started");
    vi.advanceTimersByTime(6000);
    await vi.advanceTimersByTimeAsync(1);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const events = mockFetch.mock.calls.map(([url, opts]) => JSON.parse(opts.body).event);
    expect(events).toContain("mic_pressed");
    expect(events).toContain("trial_started");
  });

  // Must stay last: the 11th event leaves a pending flush timer in module state
  // that would block scheduleFlush() in any later test (stale flushTimer).
  it("flushes eagerly once the buffer cap is hit", async () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      configurable: true,
      value: "csrf_token=test-csrf-token",
    });
    for (let i = 0; i < 11; i++) track("event");
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalled();
  });
});
