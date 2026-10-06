import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTasks } from "./useTasks";

// Regression tests for a soft-deleted task getting stuck in the timeline: it
// lives in the localStorage cache, the server already has deleted_at set, so
// every DELETE 404s and the add-only snapshot merge never removes it. The fix
// reconciles tombstones from the cursor on the first (cache-hydrated) load and
// treats a 404 delete as success.

const h = vi.hoisted(() => {
  const state = { tasks: [] as Array<{ id: string; title: string; deleted_at?: string | null }> };
  return {
    state,
    apiGet: vi.fn(),
    apiDelete: vi.fn(),
    mergeTasks: vi.fn(),
    setTasks: vi.fn(),
    track: vi.fn(),
  };
});

vi.mock("@/lib/api", () => ({
  api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: h.apiDelete },
}));

vi.mock("@/lib/track", () => ({ track: h.track }));

vi.mock("@/stores/app-store", () => {
  const state = Object.assign(h.state, {
    mergeTasks: h.mergeTasks,
    setTasks: h.setTasks,
  });
  const useAppStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state;
  useAppStore.getState = () => state;
  useAppStore.subscribe = () => () => {};
  return { useAppStore };
});

const keep = { id: "keep", title: "Keep me", deleted_at: null };
const gone = { id: "gone", title: "lidl connect", deleted_at: null };

describe("useTasks tombstone reconciliation", () => {
  beforeEach(() => {
    h.apiGet.mockReset();
    h.apiDelete.mockReset();
    h.mergeTasks.mockClear();
    h.setTasks.mockClear();
    h.track.mockClear();
    h.state.tasks = [keep, gone];
  });

  it("reconciles tombstones from the cursor on a cache-hydrated first load", async () => {
    h.apiGet.mockImplementation(async (url: string) => {
      if (url.includes("include_deleted=true")) {
        return [{ ...gone, deleted_at: "2026-10-04T23:38:46Z" }];
      }
      return [keep];
    });

    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await result.current.fetchTasks();
    });

    // The incremental (tombstone) endpoint must be queried even though no
    // snapshot has loaded yet, otherwise the deletion is never observed.
    expect(
      h.apiGet.mock.calls.some(([url]) => String(url).includes("include_deleted=true"))
    ).toBe(true);
    // The deleted task is dropped from the store.
    const removal = h.setTasks.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0].every((t) => t.id !== "gone")
    );
    expect(removal).toBeDefined();
  });

  it("treats a 404 delete (already gone) as success and clears it locally", async () => {
    h.apiDelete.mockRejectedValue(Object.assign(new Error("Task not found"), { status: 404 }));
    h.apiGet.mockResolvedValue([]);

    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await expect(result.current.deleteTask("gone")).resolves.toBeUndefined();
    });

    const removal = h.setTasks.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0].every((t) => t.id !== "gone")
    );
    expect(removal).toBeDefined();
  });

  it("still rethrows a non-404 delete error", async () => {
    h.apiDelete.mockRejectedValue(Object.assign(new Error("Server error"), { status: 500 }));
    h.apiGet.mockResolvedValue([]);

    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await expect(result.current.deleteTask("gone")).rejects.toThrow("Server error");
    });
  });
});
