"use client";

import { useSyncExternalStore } from "react";

/**
 * Reactive boolean flag backed by localStorage. Used to wire Settings toggles
 * (e.g. `prysm_feature_*`, `prysm_smartlist_*`) into the UI so they take effect
 * live and across tabs.
 */
export function useLocalBool(key: string, fallback: boolean): boolean {
  const subscribe = (cb: () => void) => {
    window.addEventListener("storage", cb);
    return () => window.removeEventListener("storage", cb);
  };
  const getSnapshot = () => {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : raw === "1" || raw === "true";
    } catch {
      return fallback;
    }
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}
