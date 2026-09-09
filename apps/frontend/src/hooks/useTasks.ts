"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { track } from "@/lib/track";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";

// Module-level lazy-window state shared by every useTasks() consumer (the app
// mounts a single workspace, so a module ref is the natural home). The loaded
// range records the widest [from, to] window already merged into the store, so
// scroll-driven fetches can grow it union-style and post-mutation refreshes can
// preserve the far window. The monotonic seq guard drops stale responses so a
// slow earlier fetch can never clobber a newer one.
let loadedRangeRef: { from: string; to: string } | null = null;
let fetchSeq = 0;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchRangeImpl(from: string, to: string, mergeTasks: (tasks: Task[]) => void) {
  // Skip when the requested window is already fully loaded; otherwise fetch
  // the union so each lazy load only ever grows the covered range.
  const loaded = loadedRangeRef;
  if (loaded && from >= loaded.from && to <= loaded.to) return;
  const unionFrom = loaded ? (from < loaded.from ? from : loaded.from) : from;
  const unionTo = loaded ? (to > loaded.to ? to : loaded.to) : to;

  const seq = ++fetchSeq;
  try {
    const data = await api.get<Task[]>(
      `/tasks/?date_from=${encodeURIComponent(unionFrom)}&date_to=${encodeURIComponent(unionTo)}`
    );
    if (seq !== fetchSeq) return; // stale response; a newer fetch superseded it
    mergeTasks(data);
    loadedRangeRef = { from: unionFrom, to: unionTo };
  } catch {
    // A failed lazy fetch must never clear or clobber the store.
  }
}

// Refresh that MERGES the /tasks/ snapshot instead of replacing the store, then
// replays the lazy far window - used by non-useTasks consumers (e.g. the AI
// chat refresh) that must never wipe far-window tasks loaded by scroll-driven
// range fetches.
export async function refreshTasksPreservingWindow() {
  const store = useAppStore.getState();
  const seq = ++fetchSeq;
  try {
    const data = await api.get<Task[]>("/tasks/");
    if (seq === fetchSeq) store.mergeTasks(data);
  } catch {
    // Keep whatever is already loaded; a failed refresh must not wipe the store.
  }
  if (loadedRangeRef) {
    await fetchRangeImpl(loadedRangeRef.from, loadedRangeRef.to, store.mergeTasks);
  }
}

export function useTasks() {
  const tasks = useAppStore((s) => s.tasks);
  const mergeTasks = useAppStore((s) => s.mergeTasks);
  const setTasks = useAppStore((s) => s.setTasks);

  const fetchRange = useCallback(
    (from: string, to: string) => fetchRangeImpl(from, to, mergeTasks),
    [mergeTasks]
  );

  const fetchTasks = useCallback(async () => {
    const seq = ++fetchSeq;
    try {
      const data = await api.get<Task[]>("/tasks/");
      if (seq === fetchSeq) mergeTasks(data);
    } catch {
      // Keep whatever is already loaded; a failed refresh must not wipe the store.
    }
    // Preserve the lazy far window across post-mutation refreshes (create/update/
    // delete otherwise reset to the 50-row legacy snapshot).
    if (loadedRangeRef) {
      await fetchRange(loadedRangeRef.from, loadedRangeRef.to);
    }
  }, [mergeTasks, fetchRange]);

  const createTask = useCallback(
    async (task: Record<string, unknown>) => {
      const data = await api.post<Task>("/tasks/", task);
      track("task_created", { source: task.source === "quick" ? "quick" : "other" });
      // Fast path: merge the created task into the store immediately so the
      // form can close after a single round trip. The background refresh then
      // reconciles ordering/derived state without blocking the UI.
      useAppStore.getState().mergeTasks([data]);
      void refreshTasksPreservingWindow();
      return data;
    },
    []
  );

  const updateTask = useCallback(
    async (id: string, fields: Record<string, unknown>) => {
      const data = await api.patch<Task>(`/tasks/${id}`, fields);
      if (fields.status === "done") track("task_completed");
      await fetchTasks();
      return data;
    },
    [fetchTasks]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      await api.delete(`/tasks/${id}`);
      // Merge out the deleted id so the merge-based refresh below can never
      // resurrect it while the response is in flight.
      setTasks(useAppStore.getState().tasks.filter((t) => t.id !== id));
      await fetchTasks();
    },
    [setTasks, fetchTasks]
  );

  // Soft delete (moves to Trash) a batch; the store drops them immediately so a
  // refresh in-flight can never bring them back. Returns {deleted: number}.
  const deleteTasksBatch = useCallback(
    async (ids: string[]): Promise<{ deleted: number }> => {
      if (ids.length === 0) return { deleted: 0 };
      const body = await api.post<{ deleted: number }>("/tasks/batch-delete", { task_ids: ids });
      const deleted = body?.deleted ?? 0;
      const keep = new Set(ids);
      setTasks(useAppStore.getState().tasks.filter((t) => !keep.has(t.id)));
      await fetchTasks();
      return { deleted };
    },
    [setTasks, fetchTasks]
  );

  const restoreTask = useCallback(
    async (id: string) => {
      await api.post(`/tasks/${id}/restore`, {});
      await fetchTasks();
    },
    [fetchTasks]
  );

  // Returns {restored: number}.
  const restoreTasksBatch = useCallback(
    async (ids: string[]): Promise<{ restored: number }> => {
      if (ids.length === 0) return { restored: 0 };
      const body = await api.post<{ restored: number }>("/tasks/batch-restore", { task_ids: ids });
      await fetchTasks();
      return { restored: body?.restored ?? 0 };
    },
    [fetchTasks]
  );

  const listTrashed = useCallback(async () => {
    return api.get<Task[]>("/tasks/trash");
  }, []);

  const permanentDelete = useCallback(async (id: string) => {
    await api.delete(`/tasks/${id}/permanent`);
  }, []);

  const emptyTrash = useCallback(async () => {
    await api.post("/tasks/trash/empty", {});
  }, []);

  return {
    tasks,
    fetchTasks,
    fetchRange,
    createTask,
    updateTask,
    deleteTask,
    deleteTasksBatch,
    restoreTask,
    restoreTasksBatch,
    listTrashed,
    permanentDelete,
    emptyTrash,
  };
}
