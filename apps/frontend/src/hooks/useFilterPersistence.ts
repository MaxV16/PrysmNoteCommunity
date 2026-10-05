"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import {
  PREF_ACTIVE_LIST,
  PREF_NAV_FILTER,
  PREF_SEARCH_QUERY,
  PREF_SELECTED_TAG,
  getPrefSync,
  isNavDefault,
  readDefaultList,
  savePreference,
} from "@/lib/preferences";

const PERSIST_DELAY_MS = 600;
const MISSING = "__prysm_missing__";

/**
 * Restores the smart-list filter, active list, selected tag and search query
 * from the user's saved preferences on load, then writes them back (debounced)
 * whenever they change, so the view a user left is the view they return to.
 *
 * `enabled` should be true only once server preferences have hydrated, so an
 * empty first paint cannot overwrite the saved filter with its defaults.
 */
export function useFilterPersistence(enabled = true): void {
  const navFilter = useAppStore((s) => s.navFilter);
  const activeListId = useAppStore((s) => s.activeListId);
  const selectedTagId = useAppStore((s) => s.selectedTagId);
  const searchQuery = useAppStore((s) => s.searchQuery);

  const seeded = useRef(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (!enabled || seeded.current) return;
    seeded.current = true;
    const store = useAppStore.getState();
    const nav = getPrefSync<string>(PREF_NAV_FILTER, MISSING);
    const list = getPrefSync<string>(PREF_ACTIVE_LIST, MISSING);
    const tag = getPrefSync<string>(PREF_SELECTED_TAG, MISSING);
    const query = getPrefSync<string>(PREF_SEARCH_QUERY, MISSING);
    if (nav !== MISSING) store.setNavFilter((nav || null) as never);
    if (list !== MISSING) store.setActiveListId(list || null);
    if (tag !== MISSING) store.setSelectedTagId(tag || null);
    if (query !== MISSING) store.setSearchQuery(query || "");

    // First visit (or cleared state): open the user's chosen default landing.
    // A returning user keeps exactly where they left, so the default only
    // applies when neither the nav filter nor the active list was ever saved.
    if (nav === MISSING && list === MISSING) {
      const def = readDefaultList();
      if (isNavDefault(def)) {
        store.setNavFilter(def as never);
        store.setActiveListId(null);
      } else {
        store.setActiveListId(def);
        store.setNavFilter(null);
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const id = window.setTimeout(() => {
      void savePreference(PREF_NAV_FILTER, navFilter).catch(() => {});
      void savePreference(PREF_ACTIVE_LIST, activeListId).catch(() => {});
      void savePreference(PREF_SELECTED_TAG, selectedTagId).catch(() => {});
      void savePreference(PREF_SEARCH_QUERY, searchQuery).catch(() => {});
    }, PERSIST_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [enabled, navFilter, activeListId, selectedTagId, searchQuery]);
}
