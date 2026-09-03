"use client";

import { api } from "@/lib/api";

export interface BoardSection {
  id: string;
  kind: "kanban" | "board";
  title: string;
  color: string | null;
  status: string | null;
  position: number;
}

export interface BoardSectionCreate {
  kind: "kanban" | "board";
  title: string;
  color?: string | null;
  status?: string | null;
}

export interface BoardSectionPatch {
  title?: string;
  color?: string | null;
  position?: number;
}

export async function fetchSections(kind: "kanban" | "board"): Promise<BoardSection[]> {
  return api.get<BoardSection[]>(`/board-sections/?kind=${kind}`);
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
