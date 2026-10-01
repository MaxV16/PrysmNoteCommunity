"use client";

import { useMemo } from "react";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import { matchesSearchQuery } from "@/lib/task-search";
import { applyNavFilter, isVisibleTask } from "@/lib/task-filters";
import type { Task } from "@/types/task";

export interface VisibleTaskFilters {
  navFilter: NavFilter;
  activeListId: string | null;
  selectedTagId: string | null;
  searchQuery: string;
}

/** Pure filter pipeline shared by every view and testable without React. */
export function filterVisibleTasks(tasks: Task[], f: VisibleTaskFilters): Task[] {
  let active = applyNavFilter(tasks.filter(isVisibleTask), f.navFilter);
  if (f.activeListId) {
    active = active.filter((t) => t.list_id === f.activeListId);
  }
  if (f.searchQuery) {
    active = active.filter((t) => matchesSearchQuery(t, f.searchQuery));
  }
  if (f.selectedTagId) {
    active = active.filter((t) => t.tags?.some((tag) => tag.id === f.selectedTagId));
  }
  return active;
}

/**
 * The single source of truth for which tasks a view should render: smart-list
 * filter + active list + tag + search. Every view uses this so the filter badge
 * and the sidebar never disagree with what is on screen.
 */
export function useVisibleTasks(): Task[] {
  const tasks = useAppStore((s) => s.tasks);
  const navFilter = useAppStore((s) => s.navFilter);
  const activeListId = useAppStore((s) => s.activeListId);
  const selectedTagId = useAppStore((s) => s.selectedTagId);
  const searchQuery = useAppStore((s) => s.searchQuery);

  return useMemo(
    () => filterVisibleTasks(tasks, { navFilter, activeListId, selectedTagId, searchQuery }),
    [tasks, navFilter, activeListId, selectedTagId, searchQuery]
  );
}
