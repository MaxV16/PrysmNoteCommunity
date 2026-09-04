"use client";

import type { BoardSection } from "@/lib/board-sections";
import type { Task, TaskStatus } from "@/types/task";

export const UNSORTED_ID = "__unsorted__";

export interface BoardDrop {
  /** Section to land in; null = the implicit "Unsorted" area. */
  sectionId: string | null;
  /** Splice index within the destination section (server renumbers from this). */
  index: number;
}

/** True when a task belongs to a section (status section: matching status and
 * not pinned to a free section; free section: pinned by id). */
export function taskInSection(task: Task, section: BoardSection): boolean {
  if (section.status) {
    return task.status === section.status && task.board_section_id == null;
  }
  return task.board_section_id === section.id;
}

export function sectionTasks(tasks: Task[], section: BoardSection): Task[] {
  return tasks.filter((t) => taskInSection(t, section));
}

export function unsortedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.board_section_id == null);
}

export function byBoardOrder(a: Task, b: Task): number {
  if (a.board_order == null && b.board_order == null) {
    return a.created_at.localeCompare(b.created_at);
  }
  if (a.board_order == null) return 1;
  if (b.board_order == null) return -1;
  return a.board_order - b.board_order;
}

/** Which section (or null for Unsorted) a task currently lives in, if any. */
export function sectionOfTask(
  task: Task,
  sections: BoardSection[]
): BoardSection | null {
  for (const section of sections) {
    if (taskInSection(task, section)) return section;
  }
  return null;
}

/**
 * Pure drop computation shared by the kanban and board scrapbook.
 *
 * - Dropping on a section header/body appends to that section.
 * - Dropping on a card resolves the card's section and computes the splice
 *   index as the card's position within the destination's sibling set (i.e. the
 *   same list the server renumbers), so the client and server agree.
 * - Dropping on the Unsorted area appends to the unsorted set.
 */
export function computeBoardDrop(
  tasks: Task[],
  sections: BoardSection[],
  activeId: string,
  overId: string
): BoardDrop | null {
  if (overId === UNSORTED_ID) {
    return { sectionId: null, index: unsortedTasks(tasks).filter((t) => t.id !== activeId).length };
  }

  const overSection = sections.find((s) => s.id === overId);
  if (overSection) {
    return {
      sectionId: overSection.id,
      index: sectionTasks(tasks, overSection).filter((t) => t.id !== activeId).length,
    };
  }

  const overTask = tasks.find((t) => t.id === overId);
  if (!overTask) return null;

  const overSectionOf = sectionOfTask(overTask, sections);
  if (!overSectionOf) return null;

  const siblings = sectionTasks(tasks, overSectionOf).filter((t) => t.id !== activeId);
  const index = siblings.findIndex((t) => t.id === overId);
  return { sectionId: overSectionOf.id, index: index === -1 ? siblings.length : index };
}

/**
 * Optimistic store update mirroring the server's board-move semantics: set
 * status (status sections) or board_section_id (free/Unsorted), then renumber
 * board_order across the destination sibling set.
 */
export function applyBoardDrop(
  tasks: Task[],
  activeId: string,
  drop: BoardDrop,
  sections: BoardSection[]
): Task[] {
  const active = tasks.find((t) => t.id === activeId);
  if (!active) return tasks;

  const section = drop.sectionId ? sections.find((s) => s.id === drop.sectionId) : null;

  let moved: Task;
  if (!section || !section.status) {
    moved = { ...active, board_section_id: section ? section.id : null };
  } else {
    moved = {
      ...active,
      status: section.status as TaskStatus,
      board_section_id: null,
    };
  }

  const destination = section
    ? sectionTasks(tasks, section)
    : unsortedTasks(tasks);
  const siblings = destination
    .filter((t) => t.id !== activeId)
    .sort(byBoardOrder);

  const index = Math.max(0, Math.min(drop.index, siblings.length));
  siblings.splice(index, 0, moved);
  const orderById = new Map(siblings.map((t, i) => [t.id, i]));

  return tasks.map((t) => {
    if (t.id === activeId) {
      return { ...moved, board_order: orderById.get(t.id) ?? null };
    }
    if (!orderById.has(t.id)) return t;
    return { ...t, board_order: orderById.get(t.id) ?? null };
  });
}

/**
 * Optimistic store update for a whole group dropped together: mirrors the
 * server's batch-board-move semantics (same membership rules as
 * `applyBoardDrop`), splicing the group at `drop.index` in `taskIds` order and
 * renumbering the destination sibling set once.
 */
export function applyBoardGroupDrop(
  tasks: Task[],
  taskIds: string[],
  drop: BoardDrop,
  sections: BoardSection[]
): Task[] {
  const movedTasks = taskIds
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t);
  if (movedTasks.length === 0) return tasks;

  const section = drop.sectionId ? sections.find((s) => s.id === drop.sectionId) : null;

  const moved = movedTasks.map((active) => {
    if (!section || !section.status) {
      return { ...active, board_section_id: section ? section.id : null };
    }
    return {
      ...active,
      status: section.status as TaskStatus,
      board_section_id: null,
    };
  });
  const movedIds = new Set(moved.map((t) => t.id));

  const destination = section ? sectionTasks(tasks, section) : unsortedTasks(tasks);
  const siblings = destination
    .filter((t) => !movedIds.has(t.id))
    .sort(byBoardOrder);

  const index = Math.max(0, Math.min(drop.index, siblings.length));
  siblings.splice(index, 0, ...moved);
  const orderById = new Map(siblings.map((t, i) => [t.id, i]));
  const movedById = new Map(moved.map((t) => [t.id, t]));

  return tasks.map((t) => {
    if (movedById.has(t.id)) {
      return { ...(movedById.get(t.id) as Task), board_order: orderById.get(t.id) ?? null };
    }
    if (!orderById.has(t.id)) return t;
    return { ...t, board_order: orderById.get(t.id) ?? null };
  });
}
