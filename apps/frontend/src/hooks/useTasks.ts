"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { track } from "@/lib/track";
import { readTaskCache, readTaskCacheCursor, writeTaskCache } from "@/lib/task-cache";
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

// Cursor for the incremental sync: the wall-clock time up to which the store is
// known to reflect the server. Advanced with a small overlap so a row written in
// the same transaction as its siblings (all share an updated_at timestamp) is
// never skipped.
let syncCursor: number | null = null;
const SYNC_OVERLAP_MS = 2000;
const SYNC_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Debounced reconcile used after a gesture-driven persist. Patching fires and
// forgets; the heavier window refresh runs once the user stops, so a drag never
// awaits a full refetch while the pointer is still moving.
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void refreshTasksPreservingWindow();
  }, 800);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cachePersistTimer: ReturnType<typeof setTimeout> | null = null;
let cachedTasksRef: Task[] | null = null;

if (typeof window !== "undefined") {
  syncCursor = readTaskCacheCursor();
  if (useAppStore.getState().tasks.length === 0) {
    const cached = readTaskCache();
    if (cached && cached.length > 0) {
      useAppStore.getState().mergeTasks(cached);
      cachedTasksRef = useAppStore.getState().tasks;
    }
  }
  useAppStore.subscribe((state) => {
    if (state.tasks === cachedTasksRef) return;
    cachedTasksRef = state.tasks;
    if (cachePersistTimer) clearTimeout(cachePersistTimer);
    cachePersistTimer = setTimeout(() => {
      cachePersistTimer = null;
      writeTaskCache(useAppStore.getState().tasks, syncCursor);
    }, 1000);
  });
}

// A full snapshot has to page: GET /tasks/ caps limit at 200, so a single
// request can never return a large import and the store would only ever hold
// the newest window. The first load walks pages until a short batch; later
// refreshes fetch only the newest page because mergeTasks is additive.
const TASK_PAGE_SIZE = 200;
// The first-load snapshot is bounded to the newest handful of pages so a large
// account never blocks the workspace behind dozens of serial requests: older
// tasks are pulled lazily by the scroll-driven range fetch, and edits are
// picked up by the incremental (updated_since) sync below.
const SNAPSHOT_MAX_PAGES = 10;
// Catch-up after being offline uses the cursor with a small overlap, so it may
// legitimately need many pages; keep the higher cap for that path only.
const TASK_MAX_PAGES = 60;
let fullSnapshotLoaded = false;

async function fetchTaskSnapshot(seq: number): Promise<Task[] | null> {
  // Page fully on the first load, and again whenever the store is empty (a
  // logout clears it), so a second account in the same tab still gets every
  // task instead of just the newest page.
  const full = !fullSnapshotLoaded || useAppStore.getState().tasks.length === 0;
  const pages = full ? SNAPSHOT_MAX_PAGES : 1;
  const all: Task[] = [];
  for (let page = 0; page < pages; page += 1) {
    const batch = await api.get<Task[]>(
      `/tasks/?limit=${TASK_PAGE_SIZE}&offset=${page * TASK_PAGE_SIZE}`
    );
    if (seq !== fetchSeq) return null; // a newer fetch superseded this one
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < TASK_PAGE_SIZE) break;
  }
  fullSnapshotLoaded = true;
  return all;
}

// Incremental sync: pull only rows changed since the cursor, tombstones
// included, oldest-first so the cursor can advance past a page once it is fully
// merged. This replaces the old newest-200-only refresh that silently missed
// every edit to an older task on a large account (edited descriptions/subtasks
// never appeared until a hard reload walked every page).
async function fetchIncrementalChanges(seq: number): Promise<Task[] | null> {
  const since =
    (syncCursor ?? Date.now() - SYNC_FALLBACK_WINDOW_MS) - SYNC_OVERLAP_MS;
  const sinceIso = encodeURIComponent(new Date(since).toISOString());
  const all: Task[] = [];
  for (let page = 0; page < TASK_MAX_PAGES; page += 1) {
    const batch = await api.get<Task[]>(
      `/tasks/?updated_since=${sinceIso}&include_deleted=true&limit=${TASK_PAGE_SIZE}&offset=${page * TASK_PAGE_SIZE}`
    );
    if (seq !== fetchSeq) return null;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < TASK_PAGE_SIZE) break;
  }
  return all;
}

function applyIncrementalChanges(changes: Task[]) {
  const store = useAppStore.getState();
  const deletedIds = new Set<string>();
  const live: Task[] = [];
  for (const change of changes) {
    if (change.deleted_at) deletedIds.add(change.id);
    else live.push(change);
  }
  if (deletedIds.size > 0) {
    store.setTasks(store.tasks.filter((t) => !deletedIds.has(t.id)));
  }
  if (live.length > 0) store.mergeTasks(live);
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
    // Reconcile tombstones/edits from the cursor whenever the store already
    // holds tasks - including the FIRST load, when it was hydrated from the
    // localStorage cache. Running this only after a snapshot (the old guard)
    // meant a task deleted on another client while this one was closed stayed
    // cached forever: the snapshot merge is add-only and then the cursor
    // advanced past the deletion, so its tombstone was never fetched.
    if (store.tasks.length > 0) {
      const changes = await fetchIncrementalChanges(seq);
      if (seq === fetchSeq && changes) {
        applyIncrementalChanges(changes);
        syncCursor = Date.now();
      }
    }
    // Snapshot when we have never paged, or whenever the store is empty (a new
    // account, or after a logout cleared it), so a cache-hydrated load both
    // reconciles tombstones above AND still fills the page window below.
    if (!fullSnapshotLoaded || store.tasks.length === 0) {
      const data = await fetchTaskSnapshot(seq);
      if (seq === fetchSeq && data) {
        store.mergeTasks(data);
        syncCursor = Date.now();
      }
    }
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
    const store = useAppStore.getState();
    try {
      // See refreshTasksPreservingWindow: reconcile tombstones from the cursor
      // whenever the store already holds tasks, so a cached task deleted
      // elsewhere this session was closed is removed on the first load.
      if (store.tasks.length > 0) {
        const changes = await fetchIncrementalChanges(seq);
        if (seq === fetchSeq && changes) {
          applyIncrementalChanges(changes);
          syncCursor = Date.now();
        }
      }
      if (!fullSnapshotLoaded) {
        const data = await fetchTaskSnapshot(seq);
        if (seq === fetchSeq && data) {
          store.mergeTasks(data);
          syncCursor = Date.now();
        }
      }
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
      // Merge the server's copy immediately so an open editor reflects the save
      // without waiting on a full snapshot refetch, then reconcile ordering and
      // derived state in the background. Awaiting `fetchTasks()` here replaced
      // the whole task object mid-edit, which is why a description edit only
      // appeared after leaving and reopening the drawer on mobile.
      useAppStore.getState().mergeTasks([data]);
      scheduleReconcile();
      return data;
    },
    []
  );

  // Gesture-friendly persist: patch and reconcile in the background instead of
  // awaiting a full `fetchTasks()` inside the interaction. Callers still do an
  // optimistic store write, so the UI stays instant.
  const persistTask = useCallback(
    async (id: string, fields: Record<string, unknown>) => {
      const data = await api.patch<Task>(`/tasks/${id}`, fields);
      if (fields.status === "done") track("task_completed");
      scheduleReconcile();
      return data;
    },
    []
  );

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        await api.delete(`/tasks/${id}`);
      } catch (err) {
        // A 404 means the row is already gone (deleted on another client or by
        // the AI, or a stale cache entry). Treat it as success so the user can
        // always clear a task instead of the delete failing forever.
        if ((err as { status?: number } | null)?.status !== 404) throw err;
      }
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
    persistTask,
    deleteTask,
    deleteTasksBatch,
    restoreTask,
    restoreTasksBatch,
    listTrashed,
    permanentDelete,
    emptyTrash,
  };
}
