import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTasks } from "./useTasks";

const h = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  mergeTasks: vi.fn(),
  setTasks: vi.fn(),
  track: vi.fn(),
  store: { tasks: [] as Record<string, unknown>[] },
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: h.apiGet,
    post: h.apiPost,
    patch: h.apiPatch,
    delete: h.apiDelete,
  },
}));

vi.mock("@/lib/track", () => ({
  track: h.track,
}));

vi.mock("@/stores/app-store", () => {
  const state = {
    get tasks() {
      return h.store.tasks;
    },
    mergeTasks: h.mergeTasks,
    setTasks: h.setTasks,
  };
  const useAppStore = (selector?: (s: unknown) => unknown) => (selector ? selector(state) : state);
  useAppStore.getState = () => state;
  useAppStore.subscribe = () => () => {};
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

// Regressions for "marking a task complete/to-do or deleting it waits for the
// server": the store must flip on the same tick as the call, not on the
// response, so a slow round trip never shows up as lag on the timeline.
describe("useTasks optimistic mutations", () => {
  const row = { ...newTask, id: "t1", status: "todo" };

  beforeEach(() => {
    h.store.tasks = [{ ...row }];
    h.apiPatch.mockReset();
    h.apiDelete.mockReset();
    h.apiPost.mockReset();
    h.mergeTasks.mockClear();
    h.setTasks.mockClear();
    h.track.mockClear();
    h.apiGet.mockResolvedValue([]);
  });

  it("writes a status change to the store before the patch resolves", async () => {
    let resolvePatch: (value: unknown) => void = () => {};
    h.apiPatch.mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = resolve;
      })
    );
    const { result } = renderHook(() => useTasks());

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.updateTask("t1", { status: "done" });
    });

    // Already flipped, with the untouched fields carried over.
    expect(h.mergeTasks).toHaveBeenCalledWith([
      expect.objectContaining({ id: "t1", status: "done", title: "Buy milk", priority: 2 }),
    ]);
    expect(h.apiPatch).toHaveBeenCalledWith("/tasks/t1", { status: "done" });

    await act(async () => {
      resolvePatch({ ...row, status: "done" });
      await pending!;
    });
  });

  it("puts the previous row back when the patch fails", async () => {
    h.apiPatch.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTasks());

    await act(async () => {
      await expect(result.current.updateTask("t1", { status: "done" })).rejects.toThrow("offline");
    });

    expect(h.mergeTasks).toHaveBeenLastCalledWith([row]);
  });

  it("drops a deleted task from the store before the request resolves", async () => {
    h.apiDelete.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTasks());

    act(() => {
      void result.current.deleteTask("t1");
    });

    expect(h.setTasks).toHaveBeenCalledWith([]);
  });

  it("drops a batch-deleted task before the request resolves", async () => {
    h.apiPost.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTasks());

    act(() => {
      void result.current.deleteTasksBatch(["t1"]);
    });

    expect(h.setTasks).toHaveBeenCalledWith([]);
  });
});