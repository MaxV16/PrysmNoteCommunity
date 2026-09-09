"use client";

import { useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { TaskList } from "@/types/task";

// Loads the user's task lists into the store and keeps them in sync after
// sidebar mutations (create/rename/delete). Fetched on mount by the sidebar;
// the store is the single source of truth for the rest of the app.
export function useLists() {
  const lists = useAppStore((s) => s.lists);
  const setLists = useAppStore((s) => s.setLists);

  const fetchLists = useCallback(async () => {
    try {
      const data = await api.get<TaskList[]>("/lists/");
      setLists(data);
    } catch {
      // Keep any already-loaded lists on a failed refresh.
    }
  }, [setLists]);

  useEffect(() => {
    void fetchLists();
  }, [fetchLists]);

  const createList = useCallback(
    async (name: string): Promise<TaskList | null> => {
      try {
        const data = await api.post<TaskList>("/lists/", { name });
        await fetchLists();
        return data;
      } catch (err) {
        throw err instanceof Error ? err : new Error("Failed to create list");
      }
    },
    [fetchLists]
  );

  const renameList = useCallback(
    async (id: string, name: string) => {
      await api.patch(`/lists/${id}`, { name });
      await fetchLists();
    },
    [fetchLists]
  );

  const deleteList = useCallback(
    async (id: string) => {
      await api.delete(`/lists/${id}`);
      const store = useAppStore.getState();
      if (store.activeListId === id) store.setActiveListId(null);
      await fetchLists();
    },
    [fetchLists]
  );

  return { lists, fetchLists, createList, renameList, deleteList };
}