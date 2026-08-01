"use client";

export function getItem<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setItem<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

import { toLocalDateString } from "@/lib/utils";

const TASKS_KEY = "prysm_tasks";

function generateId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function getLocalTasks<T>() {
  return getItem<T>(TASKS_KEY, [] as T);
}

export function setLocalTasks<T>(tasks: T) {
  setItem(TASKS_KEY, tasks);
}

export function createLocalTask(data: { title: string; description?: string; start_date?: string; due_date?: string; status?: string; priority?: number; project_id?: string | null }) {
  const tasks = getLocalTasks<any[]>();
  const today = toLocalDateString();
  const task = {
    id: generateId(),
    user_id: "local",
    project_id: data.project_id || null,
    parent_task_id: null,
    title: data.title,
    description: data.description || null,
    status: data.status || "todo",
    priority: data.priority ?? 3,
    start_date: data.start_date || today,
    due_date: data.due_date || today,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tags: [],
    links: [],
    subtasks: [],
  };
  tasks.push(task);
  setLocalTasks(tasks);
  return task;
}

export function updateLocalTask(id: string, fields: Record<string, unknown>) {
  const tasks = getLocalTasks<any[]>();
  const idx = tasks.findIndex((t: any) => t.id === id);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...fields, updated_at: new Date().toISOString() };
  setLocalTasks(tasks);
  return tasks[idx];
}

export function deleteLocalTask(id: string) {
  const tasks = getLocalTasks<any[]>();
  const filtered = tasks.filter((t: any) => t.id !== id);
  setLocalTasks(filtered);
}
