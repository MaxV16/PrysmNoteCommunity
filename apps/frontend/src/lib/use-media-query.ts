"use client";

import { useCallback, useSyncExternalStore } from "react";

const getServerSnapshot = () => false;

/**
 * Subscribe to a CSS media query. Uses an external-store subscription so the
 * value is correct as early as the client can read it (no desktop layout flash
 * on phones) while staying hydration-safe via the server snapshot.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
