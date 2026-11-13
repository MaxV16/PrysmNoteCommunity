// Id-based reordering for the subtask list. The dnd-kit SortableContext only
// renders the visible (open) subtasks, so index math against the full items
// array points at the wrong row. Moving the dragged id relative to the drop
// target's id keeps the operation correct whether or not completed rows are
// hidden, and it never re-sorts (the caller persists the explicit order).

/**
 * Move `draggedId` to the drop target's position, matching dnd-kit's visual
 * semantics: dropping onto a row above inserts before it, dropping onto a row
 * below inserts after it.
 *
 * Returns a new array, or `null` when either id is missing / identical, so a
 * no-op drop cannot allocate a state update.
 */
export function moveSubtaskById<T extends { id: string }>(
  items: readonly T[],
  draggedId: string,
  targetId: string
): T[] | null {
  if (draggedId === targetId) return null;
  const from = items.findIndex((item) => item.id === draggedId);
  const to = items.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0) return null;

  const next = items.slice();
  const [dragged] = next.splice(from, 1);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return null;
  next.splice(from < to ? targetIndex + 1 : targetIndex, 0, dragged);
  return next;
}
