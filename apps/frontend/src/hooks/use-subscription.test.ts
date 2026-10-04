import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useSubscription } from "./use-subscription";

// Minimal Response stand-in so we do not depend on the environment's fetch types.
const res = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const ACTIVE = {
  tier: "pro",
  status: "active",
  active: true,
  provider: "stripe",
  current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
};

describe("useSubscription resilience", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the last known premium status when a refresh is rate limited (429)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(ACTIVE));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSubscription("user-1"));
    await waitFor(() => expect(result.current.isPremium).toBe(true));

    fetchMock.mockResolvedValueOnce(res({ detail: "Too many requests" }, 429));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isPremium).toBe(true);
  });

  it("keeps the last known premium status on a network error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(ACTIVE));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSubscription("user-2"));
    await waitFor(() => expect(result.current.isPremium).toBe(true));

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isPremium).toBe(true);
  });

  it("reports free when the server authoritatively says the plan is inactive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ ...ACTIVE, tier: "free", status: "free", active: false }))
    );

    const { result } = renderHook(() => useSubscription("user-3"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isPremium).toBe(false);
  });

  it("downgrades to free on 401 after a failed token refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          String(url).includes("/auth/refresh") ? res({}, 401) : res({ detail: "unauth" }, 401)
        )
      )
    );

    const { result } = renderHook(() => useSubscription("user-4"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isPremium).toBe(false);
  });
});
