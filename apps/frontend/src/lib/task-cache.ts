import type { Task } from "@/types/task";

const CACHE_KEY = "prysm_task_cache_v1";
const MAX_TASKS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface TaskCachePayload {
  fetchedAt: number;
  tasks: Task[];
  lastSyncAt?: number | null;
}

function readPayload(): TaskCachePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TaskCachePayload | null;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    if (typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readTaskCache(): Task[] | null {
  const parsed = readPayload();
  if (!parsed) return null;
  if (Date.now() - parsed.fetchedAt > MAX_AGE_MS) return null;
  return parsed.tasks;
}

export function readTaskCacheCursor(): number | null {
  const parsed = readPayload();
  if (!parsed) return null;
  return typeof parsed.lastSyncAt === "number" ? parsed.lastSyncAt : null;
}

export function writeTaskCache(tasks: Task[], lastSyncAt?: number | null): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readPayload();
    const cursor =
      lastSyncAt !== undefined ? lastSyncAt : existing?.lastSyncAt ?? null;
    const payload: TaskCachePayload = {
      fetchedAt: Date.now(),
      tasks: tasks.slice(0, MAX_TASKS),
      lastSyncAt: cursor,
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    return;
  }
}

export function clearTaskCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    return;
  }
}

export const TASK_CACHE_KEY = CACHE_KEY;
