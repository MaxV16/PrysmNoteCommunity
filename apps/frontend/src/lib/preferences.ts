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

export type ScrollDirection = "horizontal" | "vertical";
export type CardLayout = "stacked" | "side_by_side";

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
