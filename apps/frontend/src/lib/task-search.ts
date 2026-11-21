import type { Task } from "@/types/task";

/**
 * Case-insensitive search over a task's title, description, and tag names.
 * Works for any search box in the app (timeline toolbar, list view, board).
 *
 * The lowercase haystack is cached per task object. Typing re-runs this for
 * every task on every keystroke, and lowercasing each description again was
 * the dominant cost; a task object is replaced when it changes, so a WeakMap
 * entry never serves stale text and never leaks.
 */
interface Haystack {
  title: string;
  description: string;
  tags: string;
}

const haystacks = new WeakMap<Task, Haystack>();

function haystackFor(task: Task): Haystack {
  const cached = haystacks.get(task);
  if (cached) return cached;
  const next: Haystack = {
    title: task.title.toLowerCase(),
    description: task.description ? task.description.toLowerCase() : "",
    tags: (task.tags ?? []).map((tag) => tag.name.toLowerCase()).join("\u0000"),
  };
  haystacks.set(task, next);
  return next;
}

export function matchesSearchQuery(task: Task, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = haystackFor(task);
  if (haystack.title.includes(q)) return true;
  if (haystack.description.includes(q)) return true;
  return haystack.tags.includes(q);
}
