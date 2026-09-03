"use client";

import { api } from "@/lib/api";

export interface StickyNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  content: string;
  color: string;
  minimized: boolean;
  open: boolean;
  zIndex?: number;
}

interface ServerNote extends Omit<StickyNote, "zIndex"> {
  sort: number;
  updated_at: string | null;
}

export const NOTES_STORAGE_KEY = "prysm_sticky_notes";
export const NOTE_COLORS = [
  "#fbbf24",
  "#f87171",
  "#60a5fa",
  "#34d399",
  "#a78bfa",
  "#f472b6",
  "#fb923c",
  "#94a3b8",
];

export function generateNoteId(): string {
  return `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function defaultNoteColor(): string {
  if (typeof window === "undefined") return NOTE_COLORS[0];
  try {
    const saved = localStorage.getItem("prysm_sticky_color");
    if (saved && NOTE_COLORS.includes(saved)) return saved;
  } catch {}
  return NOTE_COLORS[0];
}

export function noteBodyFontSize(): string {
  if (typeof window === "undefined") return "14px";
  try {
    return localStorage.getItem("prysm_sticky_font") || "14px";
  } catch {
    return "14px";
  }
}

export function loadNotes(): StickyNote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StickyNote[];
    return parsed.map((n) => ({
      ...n,
      minimized: n.minimized ?? false,
      open: n.open ?? false,
    }));
  } catch {
    return [];
  }
}

// --- Reactive module store (shared by sidebar + note windows) ---------------
type Listener = () => void;

let notes: StickyNote[] = loadNotes();
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let knownServerIds = new Set<string>();
const unsyncedDeletes = new Set<string>();
let syncing = false;

function serverPayload(n: StickyNote) {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    color: n.color,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    minimized: n.minimized,
    open: n.open,
    sort: 0,
  };
}

async function pushToServer(id: string) {
  const note = notes.find((n) => n.id === id);
  try {
    if (!note) {
      // Note was deleted locally.
      if (knownServerIds.has(id) || unsyncedDeletes.has(id)) {
        await api.delete(`/notes/${encodeURIComponent(id)}`);
        knownServerIds.delete(id);
        unsyncedDeletes.delete(id);
      }
      return;
    }
    if (knownServerIds.has(id)) {
      await api.patch(`/notes/${encodeURIComponent(id)}`, serverPayload(note));
    } else {
      await api.post("/notes", serverPayload(note));
      knownServerIds.add(id);
    }
  } catch {}
}

function scheduleServerPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const ids = notes.map((n) => n.id);
    ids.forEach((id) => void pushToServer(id));
  }, 600);
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
    } catch {}
  }, 400);
  scheduleServerPush();
}

/**
 * Write the current notes array to localStorage synchronously, bypassing the
 * 400ms debounce. Used before opening the `/notes` popup so a freshly created
 * note is present when the just-opened window loads its state.
 */
export function flushNotes(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {}
}

/**
 * Open (or focus) the standalone notes window. A fixed window name makes
 * repeated calls reuse the same popup instead of stacking new ones. When a
 * note id is passed, the popup is told to focus that note via a query param.
 */
export function openNotesWindow(focusNoteId?: string): Window | null {
  if (typeof window === "undefined") return null;
  const url = focusNoteId
    ? `/notes?focus=${encodeURIComponent(focusNoteId)}`
    : "/notes";
  return window.open(url, "prysm_notes", "width=1000,height=760,resizable=yes,scrollbars=yes");
}

/**
 * One-way sync from the server on app mount: server notes are authoritative;
 * local-only notes (created offline) are pushed up; offline deletions are
 * propagated. Merges by id without clobbering unsynced local edits.
 */
export async function syncNotesFromServer(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const server = await api.get<ServerNote[]>("/notes").catch(() => null);
    if (!server) return;
    const serverIds = new Set(server.map((n) => n.id));
    const localById = new Map(notes.map((n) => [n.id, n]));

    for (const id of unsyncedDeletes) {
      await api.delete(`/notes/${encodeURIComponent(id)}`).catch(() => {});
    }
    unsyncedDeletes.clear();

    for (const local of notes) {
      if (!serverIds.has(local.id)) {
        await api.post("/notes", serverPayload(local)).catch(() => {});
        knownServerIds.add(local.id);
      }
    }
    knownServerIds = new Set(serverIds);

    const merged: StickyNote[] = server.map((s) => {
      const local = localById.get(s.id);
      // Server wins for content/position; preserve local open/zIndex state so a
      // window that was open before sync doesn't jump around.
      return {
        ...local,
        ...s,
        zIndex: local?.zIndex,
        open: local?.open ?? s.open,
      };
    });
    notes = merged;
    emit();
    try {
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
    } catch {}
  } finally {
    syncing = false;
  }
}

function emit() {
  listeners.forEach((l) => l());
}

function mutate(next: StickyNote[]) {
  notes = next;
  persist();
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      try {
        localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
      } catch {}
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === NOTES_STORAGE_KEY) {
      notes = loadNotes();
      emit();
    }
  });
}

export function getNotes(): StickyNote[] {
  return notes;
}

export function subscribeNotes(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function upsertNote(id: string, patch: Partial<StickyNote>) {
  const existing = notes.find((n) => n.id === id);
  if (!existing) return;
  mutate(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
}

export function createNote(title = "", content = ""): StickyNote {
  const cx = typeof window !== "undefined" ? window.innerWidth / 2 - 160 : 300;
  const cy = typeof window !== "undefined" ? Math.max(80, window.innerHeight / 2 - 120) : 200;
  const note: StickyNote = {
    id: generateNoteId(),
    x: cx,
    y: cy,
    width: 320,
    height: 240,
    title,
    content,
    color: defaultNoteColor(),
    minimized: false,
    open: true,
    zIndex: (notes.reduce((max, n) => Math.max(max, n.zIndex || 0), 0) || 0) + 1,
  };
  mutate([...notes, note]);
  return note;
}

export function openNote(id: string) {
  const existing = notes.find((n) => n.id === id);
  if (!existing) return;
  const z = (notes.reduce((max, n) => Math.max(max, n.zIndex || 0), 0) || 0) + 1;
  mutate(
    notes.map((n) =>
      n.id === id ? { ...n, open: true, minimized: false, zIndex: z } : n
    )
  );
}

export function minimizeNote(id: string) {
  upsertNote(id, { open: false, minimized: true });
}

export function deleteNote(id: string) {
  if (knownServerIds.has(id)) unsyncedDeletes.add(id);
  mutate(notes.filter((n) => n.id !== id));
}
