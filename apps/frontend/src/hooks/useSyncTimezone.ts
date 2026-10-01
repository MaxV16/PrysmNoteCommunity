"use client";

import { useEffect, useRef } from "react";
import { isValidTimeZone } from "@/lib/dates";

const PRYSM_TZ_KEY = "prysm_tz";

/** Read the stored timezone which may be JSON-encoded (settings page) or raw. */
function readStoredTimezone(): string | null {
  try {
    const raw = localStorage.getItem(PRYSM_TZ_KEY);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* legacy raw value */
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * On mount, detect the browser's IANA timezone, compare it to the stored
 * value in localStorage, and sync any change to the server via the existing
 * preference endpoint.
 */
export function useSyncTimezone(): void {
  const syncedRef = useRef(false);

  useEffect(() => {
    if (syncedRef.current) return;
    syncedRef.current = true;

    const detected = isValidTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!detected) return;

    const stored = readStoredTimezone();
    if (stored === detected) return;

    // Store JSON-encoded so it matches the settings page's encoding.
    try {
      localStorage.setItem(PRYSM_TZ_KEY, JSON.stringify(detected));
    } catch {}

    // Bust the date-prefs cache so newly formatted dates use the new timezone.
    void import("@/lib/dates").then(({ invalidateDatePrefs }) => invalidateDatePrefs());

    // Sync to server silently (never block on this).
    import("@/lib/preferences").then(({ savePreference }) => {
      void savePreference(PRYSM_TZ_KEY, detected).catch(() => {});
    });
  }, []);
}
