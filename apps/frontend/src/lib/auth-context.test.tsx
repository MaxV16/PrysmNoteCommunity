import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAuth, AuthProvider } from "./auth-context";
import type { ReactNode } from "react";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { clearUserData } = vi.hoisted(() => ({ clearUserData: vi.fn() }));
vi.mock("@/lib/clear-user-data", () => ({ clearUserData }));

// Deterministic in-memory localStorage (jsdom may not expose one here).
let memStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => memStore[k] ?? null,
  setItem: (k: string, v: string) => { memStore[k] = String(v); },
  removeItem: (k: string) => { delete memStore[k]; },
  clear: () => { memStore = {}; },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("useAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default: the session probe answers "not signed in, nothing to refresh",
    // which is a 200 (public pages boot this, so a 401 would log console noise).
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ authenticated: false, refreshable: false }),
    });
  });

  it("starts in loading state", async () => {
    // Don't resolve the session fetch to keep loading=true
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it("sets user from the session probe on mount", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          authenticated: true,
          refreshable: true,
          user: { id: "1", email: "test@test.com" },
        }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({ id: "1", email: "test@test.com" });
  });

  it("refreshes token when the access token is stale but a refresh cookie exists", async () => {
    // First call = session says refreshable, second = /refresh succeeds, third =
    // session now reports the user.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ authenticated: false, refreshable: true }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            authenticated: true,
            refreshable: true,
            user: { id: "1", email: "test@test.com" },
          }),
      });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.user).toEqual({ id: "1", email: "test@test.com" });
    });
  });

  it("keeps the seeded user when the session probe fails with a transient 5xx", async () => {
    localStorage.setItem(
      "prysm_user_snapshot",
      JSON.stringify({ id: "9", email: "seed@test.com" })
    );
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({ id: "9", email: "seed@test.com" });
    expect(localStorage.getItem("prysm_user_snapshot")).not.toBeNull();
  });

  it("keeps the seeded user when the refresh call fails transiently", async () => {
    localStorage.setItem(
      "prysm_user_snapshot",
      JSON.stringify({ id: "9", email: "seed@test.com" })
    );
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ authenticated: false, refreshable: true }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({ id: "9", email: "seed@test.com" });
  });

  it("clears the seeded user when the refresh cookie is rejected", async () => {
    localStorage.setItem(
      "prysm_user_snapshot",
      JSON.stringify({ id: "9", email: "seed@test.com" })
    );
    let sessionCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      const href = String(url);
      if (href.includes("/auth/refresh")) return { ok: false, status: 401 };
      if (href.includes("/auth/session")) {
        sessionCalls += 1;
        // First probe: access token expired, refresh cookie present. The
        // confirmation probe after the rejected refresh: nothing left.
        return {
          ok: true,
          json: () =>
            Promise.resolve(
              sessionCalls === 1
                ? { authenticated: false, refreshable: true }
                : { authenticated: false, refreshable: false }
            ),
        };
      }
      return { ok: false, status: 503 };
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    // The seeded snapshot clears `loading` immediately, so wait for the refresh
    // round trip itself (the client retries a rejected refresh with a short
    // backoff before it declares the session over).
    await waitFor(() => expect(result.current.user).toBeNull(), { timeout: 5000 });
    expect(localStorage.getItem("prysm_user_snapshot")).toBeNull();
    expect(
      mockFetch.mock.calls.filter((c) => String(c[0]).includes("/auth/refresh")).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the session when a refresh is rejected but the cookie is still usable", async () => {
    // Regression: the access token's final second used to 401 every request,
    // refresh included, and the client then cleared a perfectly good session.
    localStorage.setItem(
      "prysm_user_snapshot",
      JSON.stringify({ id: "9", email: "seed@test.com" })
    );
    mockFetch.mockImplementation(async (url: string) => {
      const href = String(url);
      if (href.includes("/auth/refresh")) return { ok: false, status: 401 };
      if (href.includes("/auth/session")) {
        return {
          ok: true,
          json: () => Promise.resolve({ authenticated: false, refreshable: true }),
        };
      }
      return { ok: false, status: 503 };
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({ id: "9", email: "seed@test.com" });
    expect(localStorage.getItem("prysm_user_snapshot")).not.toBeNull();
  });

  it("never calls /auth/refresh when there is no session and no refresh cookie", async () => {
    // The bug: anonymous visitors fired /auth/me (401), /auth/refresh (401) and
    // the billing status (401) on every public page.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authenticated: false, refreshable: false }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/auth/session"))).toBe(true);
    expect(urls.some((u) => u.includes("/auth/refresh"))).toBe(false);
    expect(urls.some((u) => u.includes("/auth/me"))).toBe(false);
  });

  it("login sets user on success", async () => {
    // Mount: no session
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authenticated: false, refreshable: false }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    // Wait for mount to complete
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();

    // Login: mock the login /me call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "2", email: "a@b.com" }),
    });

    await act(async () => {
      await result.current.login("a@b.com", "pass");
    });

    expect(result.current.user).toEqual({ id: "2", email: "a@b.com" });
    // No previous account stored, so local state (incl. API keys) is kept.
    expect(clearUserData).not.toHaveBeenCalled();
  });

  it("re-login to the same account keeps cached keys", async () => {
    localStorage.setItem("prysm_user_id", "2");
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "2", email: "a@b.com" }),
    });

    await act(async () => {
      await result.current.login("a@b.com", "pass");
    });

    expect(clearUserData).not.toHaveBeenCalled();
  });

  it("login to a different account clears local keys", async () => {
    localStorage.setItem("prysm_user_id", "1");
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "2", email: "a@b.com" }),
    });

    await act(async () => {
      await result.current.login("a@b.com", "pass");
    });

    expect(clearUserData).toHaveBeenCalled();
  });

  it("login throws on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ detail: "Invalid credentials" }),
    });

    await expect(
      act(async () => result.current.login("a@b.com", "wrong"))
    ).rejects.toThrow("Invalid credentials");
  });

  it("register creates user and sets state", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "2", email: "new@b.com", display_name: "New" }),
    });

    await act(async () => {
      await result.current.register("new@b.com", "pass123", "New");
    });

    expect(result.current.user).toEqual({ id: "2", email: "new@b.com", display_name: "New" });
    // No previous account, so local state (incl. API keys) is kept.
    expect(clearUserData).not.toHaveBeenCalled();
  });

  it("logout clears user", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toBeNull();
    expect(clearUserData).toHaveBeenCalled();
  });

  it("refreshSession returns true on success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "1", email: "a@b.com" }),
      });

    const refreshed = await result.current.refreshSession();
    expect(refreshed).toBe(true);
  });

  it("refreshSession returns false on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce({ ok: false });

    const refreshed = await result.current.refreshSession();
    expect(refreshed).toBe(false);
  });
});
