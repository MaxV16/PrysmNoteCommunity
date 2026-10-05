import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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
  beforeEach(() => {
    localStorage.clear();
  });

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

  it("hydrates the cached status so a premium user is unlocked before the network resolves", async () => {
    localStorage.setItem("prysm_subscription_status:user-cache", JSON.stringify(ACTIVE));
    // A transient (rate-limited) refresh must not erase the cached premium state.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ detail: "Too many requests" }, 429)));

    const { result } = renderHook(() => useSubscription("user-cache"));
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.isPremium).toBe(true);
  });

  it("reports unresolved (not free) when there is no cache and the first fetch is transient", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ detail: "Too many requests" }, 429)));

    const { result } = renderHook(() => useSubscription("user-unknown"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolved).toBe(false);
  });

  it("ignores a cache entry written for a different user", async () => {
    localStorage.setItem("prysm_subscription_status:someone-else", JSON.stringify(ACTIVE));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ ...ACTIVE, tier: "free", status: "free", active: false }))
    );

    const { result } = renderHook(() => useSubscription("user-5"));
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.isPremium).toBe(false);
  });

  it("persists the authoritative status for the next mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(ACTIVE)));

    const { result } = renderHook(() => useSubscription("user-6"));
    await waitFor(() => expect(result.current.isPremium).toBe(true));
    await waitFor(() =>
      expect(localStorage.getItem("prysm_subscription_status:user-6")).toBeTruthy()
    );
    expect(JSON.parse(localStorage.getItem("prysm_subscription_status:user-6") as string).active).toBe(
      true
    );
  });
});
