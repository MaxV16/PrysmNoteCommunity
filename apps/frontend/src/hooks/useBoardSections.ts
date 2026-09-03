"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSection,
  deleteSection,
  fetchSections,
  updateSection,
  type BoardSection,
} from "@/lib/board-sections";

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

export function useBoardSections(kind: "kanban" | "board") {
  const [sections, setSections] = useState<BoardSection[]>([]);
  const [loading, setLoading] = useState(true);
  const migratedRef = useRef(false);

  const load = useCallback(async () => {
    if (kind === "kanban" && !migratedRef.current) {
      migratedRef.current = true;
      await migrateLegacyColumns();
    }
    const data = await fetchSections(kind);
    setSections(data);
    setLoading(false);
  }, [kind]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const addSection = useCallback(
    async (payload: { title: string; color?: string | null; status?: string | null }) => {
      const created = await createSection({ kind, ...payload });
      setSections((prev) =>
        [...prev, created].sort((a, b) => a.position - b.position)
      );
      return created;
    },
    [kind]
  );

  const renameSection = useCallback(async (id: string, title: string) => {
    const updated = await updateSection(id, { title });
    setSections((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const recolorSection = useCallback(async (id: string, color: string) => {
    const updated = await updateSection(id, { color });
    setSections((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const removeSection = useCallback(async (id: string) => {
    await deleteSection(id);
    setSections((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return {
    sections,
    loading,
    reload: load,
    addSection,
    renameSection,
    recolorSection,
    removeSection,
  };
}
