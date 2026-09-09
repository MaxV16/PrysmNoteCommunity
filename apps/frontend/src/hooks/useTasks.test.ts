import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTasks } from "./useTasks";

const h = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  mergeTasks: vi.fn(),
  setTasks: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: h.apiGet, post: h.apiPost, patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/lib/track", () => ({
  track: h.track,
}));

vi.mock("@/stores/app-store", () => {
  const state = {
    tasks: [] as unknown[],
    mergeTasks: h.mergeTasks,
    setTasks: h.setTasks,
  };
  const useAppStore = (selector?: (s: unknown) => unknown) => (selector ? selector(state) : state);
  useAppStore.getState = () => state;
  return { useAppStore };
});

const newTask = {
  id: "new1",
  title: "Buy milk",
  status: "todo",
  priority: 2,
  start_date: null,
  due_date: null,
  list_id: null,
  deleted_at: null,
};

describe("useTasks.createTask", () => {
  beforeEach(() => {
    h.apiPost.mockReset();
    h.apiGet.mockReset();
    h.mergeTasks.mockClear();
    h.track.mockClear();
    h.apiPost.mockResolvedValue(newTask);
    h.apiGet.mockResolvedValue([]);
  });

  it("merges the created task into the store immediately and returns it", async () => {
    const { result } = renderHook(() => useTasks());

    let created: unknown;
    await act(async () => {
      created = await result.current.createTask({ title: "Buy milk" });
    });

    expect(h.mergeTasks).toHaveBeenCalledWith([newTask]);
    expect(created).toEqual(newTask);
    expect(h.track).toHaveBeenCalled();
  });

  it("kicks off a background refresh instead of awaiting a full refetch", async () => {
    const { result } = renderHook(() => useTasks());

    await act(async () => {
      await result.current.createTask({ title: "Buy milk" });
    });

    // The fast path returns as soon as the POST lands; the snapshot refresh is
    // fire-and-forget, so drain the microtask queue then assert it was scheduled.
    await act(async () => {});
    expect(h.apiGet).toHaveBeenCalled();
  });

  it("returns {deleted}/{restored} counts from batch endpoints", async () => {
    h.apiPost.mockReset().mockResolvedValueOnce({ deleted: 2 }).mockResolvedValueOnce({ restored: 1 });
    h.apiGet.mockResolvedValue([]);
    const { result } = renderHook(() => useTasks());

    let deleted: { deleted: number } | undefined;
    let restored: { restored: number } | undefined;
    await act(async () => {
      deleted = await result.current.deleteTasksBatch(["a", "b"]);
      restored = await result.current.restoreTasksBatch(["a", "b"]);
    });

    expect(deleted).toEqual({ deleted: 2 });
    expect(restored).toEqual({ restored: 1 });
    expect(h.apiPost).toHaveBeenCalledWith("/tasks/batch-delete", { task_ids: ["a", "b"] });
    expect(h.apiPost).toHaveBeenCalledWith("/tasks/batch-restore", { task_ids: ["a", "b"] });
  });
});