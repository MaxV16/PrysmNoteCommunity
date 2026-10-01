"use client";

import { api } from "@/lib/api";

// Preference keys (values persisted server-side under /api/preferences/{key}
// with a localStorage cache so reads are synchronous and work offline).
export const PREF_BOARD_KANBAN_SCROLL = "board_kanban_scroll_direction";
export const PREF_BOARD_KANBAN_LAYOUT = "board_kanban_card_layout";
export const PREF_BOARD_BOARD_SCROLL = "board_board_scroll_direction";
export const PREF_BOARD_BOARD_LAYOUT = "board_board_card_layout";
export const PREF_DEFAULT_VIEW = "default_view";
export const PREF_FINANCE_CURRENCY = "finance_currency";
export const PREF_FINANCE_PROJECTION_MONTHS = "finance_projection_months";
export const PREF_FINANCE_PROJECTION_MIN_BALANCE = "finance_projection_min_balance";
export const PREF_WATCHLIST_REGION = "watchlist_region";
export const PREF_ONBOARDING_DONE = "onboarding_done";
// Per-list last-used view mode (map of list id -> view mode) so opening a list
// restores the view it was last seen in. Server-synced like every other pref.
export const PREF_LIST_VIEWS = "list_views";
// Sidebar list grouping: user-created collapsible sections that lists are
// dragged into. Persisted as one pref value so it syncs across devices.
export const PREF_LIST_SECTIONS = "list_sections";
// Active task-filter state (smart list, active list, tag, search) so returning
// to the app restores exactly the view the user left. Server-synced like every
// other preference, with the localStorage cache for a flash-free first paint.
export const PREF_NAV_FILTER = "nav_filter";
export const PREF_ACTIVE_LIST = "active_list";
export const PREF_SELECTED_TAG = "selected_tag";
export const PREF_SEARCH_QUERY = "search_query";

export type ScrollDirection = "horizontal" | "vertical";
export type CardLayout = "stacked" | "side_by_side";

/** Map of list id -> last-used timeline view mode. */
export type ListViewsMap = Record<string, string>;

/** A user-created collapsible sidebar group of lists. */
export interface ListSection {
  id: string;
  name: string;
  collapsed?: boolean;
  listIds: string[];
}

export interface ListSectionsConfig {
  sections: ListSection[];
}

export function readListViews(): ListViewsMap {
  const value = getPrefSync<unknown>(PREF_LIST_VIEWS, {});
  return value && typeof value === "object" ? (value as ListViewsMap) : {};
}

export function readListSections(): ListSection[] {
  const value = getPrefSync<unknown>(PREF_LIST_SECTIONS, null);
  if (value && typeof value === "object" && Array.isArray((value as ListSectionsConfig).sections)) {
    return (value as ListSectionsConfig).sections;
  }
  return [];
}

export const PREFERENCES_KEY = "prysm_preferences";

export function readPreferenceCache(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writePreferenceCache(prefs: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Synchronous cached read - used for the AppShell initial viewMode so there is
 * no async flash between first paint and server hydration.
 */
export function getPrefSync<T>(key: string, fallback: T): T {
  const cache = readPreferenceCache();
  return key in cache ? (cache[key] as T) : fallback;
}

/** Fetch all server prefs and merge them over the local cache (server wins). */
export async function loadPreferencesFromServer(): Promise<Record<string, unknown>> {
  try {
    const server = await api.get<Record<string, unknown>>("/preferences/");
    const merged = { ...readPreferenceCache(), ...server };
    writePreferenceCache(merged);
    return merged;
  } catch {
    return readPreferenceCache();
  }
}

/** Update the local cache and push to the server. Throws on server failure so
 * the caller (preferences store) can roll back its optimistic state. */
export async function savePreference(key: string, value: unknown): Promise<void> {
  const merged = { ...readPreferenceCache(), [key]: value };
  writePreferenceCache(merged);
  await api.put(`/preferences/${encodeURIComponent(key)}`, { value });
}
