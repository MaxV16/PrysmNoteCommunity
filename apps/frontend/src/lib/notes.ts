"use client";

import { api } from "@/lib/api";
import { getDesktopBridge } from "@/lib/desktop-bridge";

export interface StickyNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  content: string;
  color: string;
  alwaysOnTop?: boolean;
  minimized: boolean;
  open: boolean;
  zIndex?: number;
}

interface ServerNote extends Omit<StickyNote, "zIndex"> {
  sort: number;
  updated_at: string | null;
}

export const NOTES_STORAGE_KEY = "prysm_sticky_notes";
export const NOTES_SYNCED_KEY = "prysm_sticky_notes_synced";
export const NOTES_DELETED_KEY = "prysm_sticky_notes_deleted";
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
      alwaysOnTop: n.alwaysOnTop ?? true,
    }));
  } catch {
    return [];
  }
}

/**
 * Ids we last confirmed on the server, persisted so a fresh page load can tell
 * a brand-new offline note (push it) from a note that already existed on the
 * server but is gone now (deleted on another device: drop it).
 */
function loadSyncedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(NOTES_SYNCED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveSyncedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(NOTES_SYNCED_KEY, JSON.stringify([...ids]));
  } catch {}
}

/**
 * Durable tombstones for locally deleted notes. A deleted id stays here until a
 * server snapshot confirms it is gone, so a stale GET (taken before the DELETE
 * landed) or a note re-posted by another window can never resurrect it.
 */
function loadDeletedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(NOTES_DELETED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveDeletedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(NOTES_DELETED_KEY, JSON.stringify([...ids]));
  } catch {}
}

// --- Reactive module store (shared by sidebar + note windows) ---------------
type Listener = () => void;

const deletedIds = loadDeletedIds();
let notes: StickyNote[] = loadNotes().filter((n) => !deletedIds.has(n.id));
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let knownServerIds = loadSyncedIds();
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
      // Note was deleted locally. Always tell the server so the deletion reaches
      // the other devices; the API returns 404 when it is already gone, which
      // the outer catch swallows. The tombstone in `deletedIds` stays put until
      // a later sync confirms the server no longer has it.
      if (unsyncedDeletes.has(id) || knownServerIds.has(id) || deletedIds.has(id)) {
        await api.delete(`/notes/${encodeURIComponent(id)}`);
      }
      knownServerIds.delete(id);
      unsyncedDeletes.delete(id);
      saveSyncedIds(knownServerIds);
      return;
    }
    if (knownServerIds.has(id)) {
      await api.patch(`/notes/${encodeURIComponent(id)}`, serverPayload(note));
    } else {
      await api.post("/notes/", serverPayload(note));
      knownServerIds.add(id);
      saveSyncedIds(knownServerIds);
    }
  } catch {}
}

function scheduleServerPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const ids = new Set([...notes.map((n) => n.id), ...unsyncedDeletes]);
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
 * Open one note as its own small floating window. This is the default notes
 * experience: pressing Notes or + pops open a single sticky note, not a
 * dashboard. The popup renders the note standalone (see StickyNoteClient) and
 * syncs edits back through the shared note store.
 */
export function openStickyWindow(noteId: string): Window | null {
  if (typeof window === "undefined") return null;
  return window.open(
    `/notes/sticky/${encodeURIComponent(noteId)}`,
    `sticky_${noteId}`,
    "width=360,height=340,resizable=yes,scrollbars=yes"
  );
}

/**
 * Reconcile the local store with the server. The contract is deliberately
 * simple and symmetric so a change made on one device shows up on the others:
 *
 *   1. Local deletions are pushed first, then excluded from the server
 *      snapshot so they can never be resurrected by this same pass.
 *   2. A local note missing from the server is either brand new (push it) or
 *      one that already existed before and is now gone (deleted on another
 *      device, drop it). Ids we previously confirmed on the server tell them
 *      apart.
 *   3. Server notes are merged in, server content winning while local
 *      open/zIndex state is preserved so an open window does not jump.
 */
export async function syncNotesFromServer(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const server = await api.get<ServerNote[]>("/notes/").catch(() => null);
    if (!server) return;

    // Push pending offline deletions. The durable `deletedIds` tombstones
    // (retired only once the server confirms the note is gone, further below)
    // keep the snapshot we just took, which was captured before these deletes
    // landed, from bringing the notes back.
    for (const id of unsyncedDeletes) {
      await api.delete(`/notes/${encodeURIComponent(id)}`).catch(() => {});
      knownServerIds.delete(id);
    }
    unsyncedDeletes.clear();

    const serverNotes = server.filter((s) => !deletedIds.has(s.id));
    const serverIds = new Set(serverNotes.map((n) => n.id));
    // Ignore any tombstoned note that a stale cross-window reload put back into
    // the local array, so it is never re-posted.
    const localNotes = notes.filter((n) => !deletedIds.has(n.id));
    const localById = new Map(localNotes.map((n) => [n.id, n]));
    const previouslySynced = new Set(knownServerIds);

    const pushed = new Set<string>();
    for (const local of localNotes) {
      if (serverIds.has(local.id)) continue;
      if (previouslySynced.has(local.id)) continue; // deleted on another device
      await api.post("/notes/", serverPayload(local)).catch(() => {});
      pushed.add(local.id);
    }

    const merged: StickyNote[] = serverNotes.map((s) => {
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
    for (const local of localNotes) {
      if (pushed.has(local.id)) merged.push(local);
    }

    // Retire a tombstone only once the server snapshot confirms the note is
    // gone. Until then it must survive so a stale snapshot stays filtered.
    const serverAllIds = new Set(server.map((n) => n.id));
    for (const id of [...deletedIds]) {
      if (!serverAllIds.has(id)) deletedIds.delete(id);
    }
    saveDeletedIds(deletedIds);

    notes = merged;
    knownServerIds = new Set([...serverIds, ...pushed]);
    saveSyncedIds(knownServerIds);
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
      // Apply local tombstones on reload so a stale cross-window write cannot
      // resurrect a note this window already deleted.
      notes = loadNotes().filter((n) => !deletedIds.has(n.id));
      emit();
    } else if (e.key === NOTES_DELETED_KEY) {
      // Another window deleted a note: adopt its tombstones durably and drop
      // any local copy so it disappears here too.
      for (const id of loadDeletedIds()) deletedIds.add(id);
      saveDeletedIds(deletedIds);
      const next = notes.filter((n) => !deletedIds.has(n.id));
      if (next.length !== notes.length) {
        notes = next;
        emit();
      }
    }
  });
  // Reconcile with the server when the app returns to the foreground so a note
  // deleted on another device disappears here without a manual reload.
  let lastForegroundSync = 0;
  const handleForeground = () => {
    const now = Date.now();
    if (now - lastForegroundSync < 5000) return;
    lastForegroundSync = now;
    void syncNotesFromServer();
  };
  window.addEventListener("focus", handleForeground);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") handleForeground();
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
    alwaysOnTop: true,
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
  // Always record the deletion so it reaches the server and the other devices,
  // even for a note that was never pushed (created offline, deleted before the
  // debounced push ran). The durable tombstone is written synchronously so a
  // concurrent sync, a stale snapshot, or another window cannot resurrect it.
  unsyncedDeletes.add(id);
  deletedIds.add(id);
  saveDeletedIds(deletedIds);
  knownServerIds.delete(id);
  saveSyncedIds(knownServerIds);
  mutate(notes.filter((n) => n.id !== id));
}

export interface NativeStickyWindowInfo {
  windowId: string;
  noteId: string;
  bounds?: { x: number; y: number; width: number; height: number };
  alwaysOnTop: boolean;
}

/**
 * Check if native sticky windows are supported (running in desktop app)
 */
export function isNativeStickySupported(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = getDesktopBridge();
  return !!bridge?.sticky;
}

/**
 * Open a note as a native sticky window (always-on-top, frameless)
 */
export async function openNativeStickyNote(note: StickyNote): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.create) return null;
  try {
    const windowId = await bridge.sticky.create({
      noteId: note.id,
      x: note.x,
      y: note.y,
      width: note.width,
      height: note.height,
      color: note.color,
      title: note.title,
      content: note.content,
      minimized: note.minimized,
      alwaysOnTop: true,
    });
    return windowId;
  } catch {
    return null;
  }
}

/**
 * Close a native sticky window by windowId
 */
export async function closeNativeStickyNote(windowId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.close) return;
  try {
    await bridge.sticky.close(windowId);
  } catch {}
}

/**
 * Update a native sticky window (position, size, color, alwaysOnTop)
 */
export async function updateNativeStickyNote(windowId: string, patch: Partial<StickyNote> & { alwaysOnTop?: boolean }): Promise<void> {
  if (typeof window === "undefined") return;
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.update) return;
  try {
    await bridge.sticky.update(windowId, patch);
  } catch {}
}

/**
 * Set always-on-top for a native sticky window
 */
export async function setNativeStickyAlwaysOnTop(windowId: string, onTop: boolean): Promise<void> {
  if (typeof window === "undefined") return;
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.setAlwaysOnTop) return;
  try {
    await bridge.sticky.setAlwaysOnTop(windowId, onTop);
  } catch {}
}

/**
 * Get all open native sticky windows
 */
export async function getNativeStickyWindows(): Promise<NativeStickyWindowInfo[]> {
  if (typeof window === "undefined") return [];
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.getAll) return [];
  try {
    return await bridge.sticky.getAll();
  } catch {
    return [];
  }
}

/**
 * Get native sticky window by note ID
 */
export async function getNativeStickyByNoteId(noteId: string): Promise<NativeStickyWindowInfo | null> {
  if (typeof window === "undefined") return null;
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.getByNoteId) return null;
  try {
    return await bridge.sticky.getByNoteId(noteId);
  } catch {
    return null;
  }
}

/**
 * Subscribe to native sticky window closed events
 */
export function subscribeNativeStickyClosed(callback: (data: { windowId: string; noteId: string }) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.onClosed) return () => {};
  bridge.sticky.onClosed(callback);
  return () => {
    // Note: Electron's ipcRenderer.on returns a function to remove the listener
    // but our bridge doesn't expose that, so we can't actually unsubscribe
  };
}

/**
 * Subscribe to native sticky note updates (from native window to main app)
 */
export function subscribeNativeStickyNoteUpdated(callback: (data: { noteId: string } & Partial<StickyNote>) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.onNoteUpdated) return () => {};
  bridge.sticky.onNoteUpdated(callback);
  return () => {};
}

/**
 * Subscribe to native sticky note minimized events
 */
export function subscribeNativeStickyNoteMinimized(callback: (data: { noteId: string }) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bridge = getDesktopBridge();
  if (!bridge?.sticky?.onNoteMinimized) return () => {};
  bridge.sticky.onNoteMinimized(callback);
  return () => {};
}
