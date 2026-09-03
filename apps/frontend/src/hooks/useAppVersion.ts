"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";

// Baked at `next build` time (deploy pipelines pass NEXT_PUBLIC_GIT_SHA). Empty
// in local/dev builds, which disables the update banner entirely.
const BAKED_SHA = process.env.NEXT_PUBLIC_GIT_SHA || "";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Detects whether the browser is running a stale frontend bundle: compares the
 * SHA baked into this build against the SHA the frontend currently serves from
 * `/version` (no-store, so it is never cached). Only a real frontend deploy can
 * change `/version`, so backend-only releases never show the banner.
 */
export function useAppVersion() {
  const { user } = useAuth();
  const [outdated, setOutdated] = useState(false);

  const check = useCallback(async () => {
    if (!BAKED_SHA) return; // dev build has nothing to compare
    try {
      const res = await fetch("/version", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { version?: string | null };
      if (data.version && data.version !== BAKED_SHA) {
        setOutdated(true);
      }
    } catch {
      // Network hiccup - the next poll retries.
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user, check]);

  // Cache-busting reload: a plain location.reload() may re-serve the cached
  // HTML (and its old chunk hashes). Navigating with a fresh query param forces
  // the browser/CDN to fetch the current page, which references the new chunks.
  const reload = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(Date.now()));
    window.location.assign(url.toString());
  }, []);

  // Strip the cache-buster query param once the fresh page has loaded.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("v")) {
      url.searchParams.delete("v");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, []);

  return { outdated, reload };
}
