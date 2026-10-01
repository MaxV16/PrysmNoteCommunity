"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoOrganizeSections,
  createSection,
  deleteSection,
  fetchSections,
  updateSection,
  type AutoOrganizeResult,
  type BoardSection,
} from "@/lib/board-sections";
import { FOREGROUND_REFRESH_EVENT } from "@/hooks/useForegroundRefresh";

const KANBAN_COLUMNS_KEY = "prysm_kanban_columns";
const KANBAN_MIGRATED_FLAG = "prysm_kanban_columns_migrated";

interface LegacyColumn {
  id: string;
  title: string;
  color: string;
  status: string;
}

/**
 * One-time migration of the pre-server `prysm_kanban_columns` localStorage
 * columns into server sections (upserted by status, so re-running is safe).
 * Only marks the migration done once every POST succeeded; a failure keeps the
 * localStorage key so the next load retries instead of losing the user's layout.
 */
async function migrateLegacyColumns(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(KANBAN_MIGRATED_FLAG)) return;
    const raw = window.localStorage.getItem(KANBAN_COLUMNS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as LegacyColumn[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      window.localStorage.removeItem(KANBAN_COLUMNS_KEY);
      window.localStorage.setItem(KANBAN_MIGRATED_FLAG, "1");
      return;
    }
    for (const col of parsed) {
      if (col && col.status) {
        await createSection({
          kind: "kanban",
          title: col.title,
          color: col.color,
          status: col.status,
        });
      }
    }
    window.localStorage.removeItem(KANBAN_COLUMNS_KEY);
    window.localStorage.setItem(KANBAN_MIGRATED_FLAG, "1");
  } catch {
    // Best-effort: keep the localStorage key so the migration retries later.
  }
}

/**
 * Load a board kind's sections. ``listId`` scopes them to one task list (used
 * by the timeline so each list has its own sections); ``null`` is the no-list /
 * workspace-wide scope used by kanban and board.
 */
export function useBoardSections(
  kind: "kanban" | "board" | "timeline",
  listId: string | null = null
) {
  const [sections, setSections] = useState<BoardSection[]>([]);
  const [loading, setLoading] = useState(true);
  const migratedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      if (kind === "kanban" && !migratedRef.current) {
        migratedRef.current = true;
        await migrateLegacyColumns();
      }
      const data = await fetchSections(kind, listId);
      setSections(data);
    } catch {
      // Network/auth failure: keep the current sections instead of surfacing an
      // unhandled rejection, and clear loading so the UI never hangs on empty.
    } finally {
      setLoading(false);
    }
  }, [kind, listId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Cross-device sync: returning to the app reloads the server list, so a
  // section created/renamed/deleted on another device shows up here.
  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
  }, [load]);

  const addSection = useCallback(
    async (payload: { title: string; color?: string | null; status?: string | null }) => {
      const created = await createSection({ kind, list_id: listId, ...payload });
      setSections((prev) =>
        [...prev, created].sort((a, b) => a.position - b.position)
      );
      return created;
    },
    [kind, listId]
  );

  const renameSection = useCallback(
    async (id: string, title: string) => {
      const updated = await updateSection(id, { title });
      setSections((prev) => prev.map((s) => (s.id === id ? updated : s)));
      // Reconcile with the server so a stale list elsewhere cannot overwrite.
      await load();
    },
    [load]
  );

  const recolorSection = useCallback(
    async (id: string, color: string) => {
      const updated = await updateSection(id, { color });
      setSections((prev) => prev.map((s) => (s.id === id ? updated : s)));
      await load();
    },
    [load]
  );

  const removeSection = useCallback(
    async (id: string) => {
      await deleteSection(id);
      setSections((prev) => prev.filter((s) => s.id !== id));
      // Reload from the server rather than trusting the local list, so a second
      // device's stale order cannot resurrect a deleted section.
      await load();
    },
    [load]
  );

  /** AI-classify dated tasks into timeline topic sections, then reload them. */
  const autoOrganize = useCallback(
    async (options?: { force?: boolean; provider?: string | null }): Promise<AutoOrganizeResult> => {
      const result = await autoOrganizeSections({ ...options, listId });
      await load();
      return result;
    },
    [load, listId]
  );

  /** Reorder a section one slot up/down and persist the new positions. */
  const moveSection = useCallback(
    async (id: string, dir: "up" | "down") => {
      const idx = sections.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const swap = dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= sections.length) return;
      const reordered = [...sections];
      [reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]];
      setSections(reordered);
      // Persist the new positions; failures roll back to the server order.
      try {
        await Promise.all(
          reordered.map((s, position) => updateSection(s.id, { position }))
        );
        // Re-read the persisted order so another device's stale copy cannot
        // win on the next foreground refresh.
        await load();
      } catch {
        await load();
      }
    },
    [sections, load]
  );

  return {
    sections,
    loading,
    reload: load,
    addSection,
    renameSection,
    recolorSection,
    removeSection,
    moveSection,
    autoOrganize,
  };
}
