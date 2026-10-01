"use client";

import { api } from "@/lib/api";

export interface BoardSection {
  id: string;
  kind: "kanban" | "board" | "timeline";
  list_id: string | null;
  title: string;
  color: string | null;
  status: string | null;
  position: number;
}

export interface BoardSectionCreate {
  kind: "kanban" | "board" | "timeline";
  title: string;
  color?: string | null;
  status?: string | null;
  list_id?: string | null;
}

export interface BoardSectionPatch {
  title?: string;
  color?: string | null;
  position?: number;
}

/**
 * Fetch a board kind's sections. ``listId`` scopes timeline sections to one
 * task list; ``null`` means the no-list scope. Kanban/board omit it.
 */
export async function fetchSections(
  kind: "kanban" | "board" | "timeline",
  listId?: string | null
): Promise<BoardSection[]> {
  const params = new URLSearchParams({ kind });
  if (listId !== undefined) params.set("list_id", listId ?? "");
  return api.get<BoardSection[]>(`/board-sections/?${params.toString()}`);
}

export async function createSection(payload: BoardSectionCreate): Promise<BoardSection> {
  return api.post<BoardSection>("/board-sections/", payload);
}

export async function updateSection(id: string, patch: BoardSectionPatch): Promise<BoardSection> {
  return api.patch<BoardSection>(`/board-sections/${id}`, patch);
}

export async function deleteSection(id: string): Promise<void> {
  await api.delete(`/board-sections/${id}`);
}

export interface AutoOrganizeResult {
  sections_created: number;
  tasks_assigned: number;
  topics: string[];
  skipped: boolean;
  /** Active dated tasks still unpinned after the run (a second press finishes them). */
  remaining: number;
}

/** AI-classify dated tasks into timeline topic sections (spends the user's AI). */
export async function autoOrganizeSections(options?: {
  force?: boolean;
  provider?: string | null;
  listId?: string | null;
}): Promise<AutoOrganizeResult> {
  return api.post<AutoOrganizeResult>("/board-sections/auto-organize", {
    force: options?.force ?? false,
    provider: options?.provider ?? null,
    list_id: options?.listId ?? null,
  });
}
