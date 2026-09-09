import type { Task } from "@/types/task";

/**
 * Build the payload for a client-side duplicate of a task. Copies the
 * user-facing fields but deliberately excludes recurrence, parent/board
 * placement and subtasks; the new task defaults to status "todo" (the backend
 * default) so it starts as an independent open task.
 */
export function buildDuplicatePayload(task: Task) {
  return {
    title: task.title,
    description: task.description,
    start_date: task.start_date,
    due_date: task.due_date,
    priority: task.priority,
    estimated_minutes: task.estimated_minutes,
    tag_ids: (task.tags ?? []).map((t) => t.id),
    list_id: task.list_id ?? undefined,
  };
}
