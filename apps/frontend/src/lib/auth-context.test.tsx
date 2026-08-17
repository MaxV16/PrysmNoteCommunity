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
    // Default: /me returns 401 (no session)
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
  });

  it("starts in loading state", async () => {
    // Don't resolve the /me fetch to keep loading=true
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it("sets user from /me on mount", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "1", email: "test@test.com" }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({ id: "1", email: "test@test.com" });
  });

  it("refreshes token if /me fails on mount", async () => {
    // First call = /me fails, second = /refresh succeeds, third = /me succeeds
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "1", email: "test@test.com" }),
      });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.user).toEqual({ id: "1", email: "test@test.com" });
    });
  });

  it("login sets user on success", async () => {
    // Mount: /me fails
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

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
