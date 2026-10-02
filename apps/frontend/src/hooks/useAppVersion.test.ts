import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const auth = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: auth.user }),
}));

// The hook reads NEXT_PUBLIC_GIT_SHA into a module-level constant at import
// time, so each case re-imports it with the desired baked SHA.
async function loadHook(bakedSha: string) {
  vi.stubEnv("NEXT_PUBLIC_GIT_SHA", bakedSha);
  vi.resetModules();
  return (await import("./useAppVersion")).useAppVersion;
}

function mockFetch(version: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let replaceMock: ReturnType<typeof vi.fn>;
let assignMock: ReturnType<typeof vi.fn>;

describe("useAppVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    auth.user = { id: "u1" };
    replaceMock = vi.fn();
    assignMock = vi.fn();
    // jsdom's location is read-only; swap in a mock so we can observe the
    // cache-busting navigation the reload callback performs.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "http://localhost/app", replace: replaceMock, assign: assignMock },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not show the banner when the running bundle matches the deployed version", async () => {
    const useAppVersion = await loadHook("sha-1");
    mockFetch("sha-1");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.outdated).toBe(false);
  });

  it("shows the banner when the running bundle is behind", async () => {
    const useAppVersion = await loadHook("sha-old");
    mockFetch("sha-new");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current.outdated).toBe(true));
  });

  it("persists the update so a later launch (same or cached bundle) is not nagged", async () => {
    // Session 1: bundle on sha-2, a real deploy to sha-2, still shows (nothing
    // acknowledged yet) and records the reload target.
    const first = await loadHook("sha-2");
    mockFetch("sha-2");
    const a = renderHook(() => first());
    await waitFor(() => expect(a.result.current.outdated).toBe(false));
    expect(localStorage.getItem("prysm_git_sha")).toBe("sha-2");
    a.unmount();

    // Session 2: a cached bundle (baked sha-2) is served while the server is on
    // sha-2. No banner, even though nothing is "baked" differently.
    const second = await loadHook("sha-2");
    mockFetch("sha-2");
    const b = renderHook(() => second());
    await waitFor(() => expect(b.result.current.outdated).toBe(false));
  });

  it("reloads with location.replace so mobile back cannot return to the old version", async () => {
    const useAppVersion = await loadHook("sha-old");
    mockFetch("sha-new");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current.outdated).toBe(true));

    result.current.reload();
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
    expect(String(replaceMock.mock.calls[0][0])).toContain("v=");
    expect(localStorage.getItem("prysm_git_sha")).toBe("sha-new");
  });

  it("shows the banner on a stale chunk load error even when versions match", async () => {
    const useAppVersion = await loadHook("sha-1");
    mockFetch("sha-1");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.outdated).toBe(false);

    act(() => {
      const err = new Error("Loading chunk 123 failed.");
      err.name = "ChunkLoadError";
      window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }));
    });

    await waitFor(() => expect(result.current.outdated).toBe(true));
  });

  it("ignores unrelated runtime errors", async () => {
    const useAppVersion = await loadHook("sha-1");
    mockFetch("sha-1");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.outdated).toBe(false);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", { error: new Error("Some unrelated failure"), message: "Some unrelated failure" })
      );
    });

    expect(result.current.outdated).toBe(false);
  });

  it("shows the banner when a hashed Next chunk script fails to load", async () => {
    const useAppVersion = await loadHook("sha-1");
    mockFetch("sha-1");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.outdated).toBe(false);

    act(() => {
      const script = document.createElement("script");
      script.src = "http://localhost/_next/static/chunks/old-build.js";
      document.body.appendChild(script);
      script.dispatchEvent(new Event("error"));
      script.remove();
    });

    await waitFor(() => expect(result.current.outdated).toBe(true));
  });
});
