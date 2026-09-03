"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  TMDBResult,
  WatchlistItem,
  WatchlistMediaType,
  WatchlistStatus,
  WatchlistUpdate,
  WatchProviders,
} from "@/types/watchlist";

export interface WatchlistAddPayload {
  tmdb_id: number;
  media_type: WatchlistMediaType;
  title?: string;
  release_year?: number | null;
  poster_path?: string | null;
  status?: WatchlistStatus;
  rating?: number | null;
  notes?: string | null;
}

// Monotonic guard so a slow initial fetch can never clobber a newer mutation
// (same pattern as useTasks' fetchSeq).
let fetchSeq = 0;

export function useWatchlist() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    const seq = ++fetchSeq;
    try {
      const data = await api.get<WatchlistItem[]>("/watchlist/");
      if (seq === fetchSeq) setItems(data);
    } catch {
      // Keep whatever is loaded; a failed refresh must not wipe the list.
    } finally {
      if (seq === fetchSeq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const search = useCallback(async (query: string): Promise<TMDBResult[]> => {
    try {
      return await api.post<TMDBResult[]>(
        `/watchlist/search?query=${encodeURIComponent(query)}`
      );
    } catch {
      return [];
    }
  }, []);

  const add = useCallback(async (payload: WatchlistAddPayload) => {
    fetchSeq++;
    const created = await api.post<WatchlistItem>("/watchlist/", payload);
    setItems((prev) => [created, ...prev]);
    return created;
  }, []);

  const update = useCallback(async (id: string, fields: WatchlistUpdate) => {
    fetchSeq++;
    const updated = await api.patch<WatchlistItem>(`/watchlist/${id}`, fields);
    setItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    fetchSeq++;
    await api.delete(`/watchlist/${id}`);
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const fetchProviders = useCallback(
    async (id: string, region: string): Promise<WatchProviders> => {
      try {
        return await api.get<WatchProviders>(
          `/watchlist/${id}/providers?region=${encodeURIComponent(region)}`
        );
      } catch {
        return {};
      }
    },
    []
  );

  return {
    items,
    loading,
    fetchItems,
    search,
    add,
    update,
    remove,
    fetchProviders,
  };
}
