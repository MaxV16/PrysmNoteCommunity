import type { Task } from "@/types/task";

/**
 * Case-insensitive search over a task's title, description, and tag names.
 * Works for any search box in the app (timeline toolbar, list view, board).
 */
export function matchesSearchQuery(task: Task, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (task.title.toLowerCase().includes(q)) return true;
  if (task.description && task.description.toLowerCase().includes(q)) return true;
  return task.tags?.some((tag) => tag.name.toLowerCase().includes(q)) ?? false;
}
