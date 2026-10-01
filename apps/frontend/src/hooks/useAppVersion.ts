"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";

// Baked at `next build` time (deploy pipelines pass NEXT_PUBLIC_GIT_SHA). Empty
// in local/dev builds, which disables the update banner entirely.
const BAKED_SHA = process.env.NEXT_PUBLIC_GIT_SHA || "";

// The deployed version this client has already loaded (or explicitly updated to).
// Persisted across sessions so a bundle still served from a cache does not
// re-prompt on every launch.
const STORAGE_KEY = "prysm_git_sha";

// Poll infrequently: live change sync runs over SSE, so this is only the
// "a new bundle was deployed" check, which does not need 30s granularity.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

function readStoredSha(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredSha(version: string): void {
  if (typeof window === "undefined" || !version) return;
  try {
    localStorage.setItem(STORAGE_KEY, version);
  } catch {
    // Storage unavailable (private mode): fall back to the baked SHA only.
  }
}

/**
 * Detects whether the browser is running a stale frontend bundle: compares the
 * version baked into this build (or the last version this client acknowledged)
 * against the SHA the frontend currently serves from `/version` (no-store, so it
 * is never cached). Only a real frontend deploy can change `/version`, so
 * backend-only releases never show the banner.
 */
export function useAppVersion() {
  const { user } = useAuth();
  const [outdated, setOutdated] = useState(false);
  // Version this client considers current. Prefers the persisted acknowledged
  // value (so a bundle still served from a cache does not re-prompt every
  // launch) and seeds from the baked SHA only when nothing has been stored yet.
  const knownRef = useRef<string>(readStoredSha() || BAKED_SHA);
  // Latest version reported by `/version`, used to record the acknowledged
  // version when the user reloads.
  const deployedRef = useRef<string>("");

  const check = useCallback(async () => {
    try {
      const res = await fetch("/version", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { version?: string | null };
      const deployed = data.version || "";
      if (!deployed) return;
      deployedRef.current = deployed;

      // The version this client last acknowledged (persisted across sessions),
      // falling back to the SHA baked into the running bundle.
      let known = readStoredSha() || BAKED_SHA;
      // Either the running bundle is already current, or nothing has been
      // acknowledged yet: record the deployed version so the next launch is not
      // nagged, even if this bundle is later served from a cache.
      if (!known || deployed === BAKED_SHA || deployed === known) {
        known = deployed;
        writeStoredSha(deployed);
      }
      knownRef.current = known;
      // Always set both directions so a transient or stale `/version` cannot pin
      // the banner for the rest of the session.
      setOutdated(deployed !== known);
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
  // `replace` (not `assign`) swaps the current history entry, so a hardware back
  // gesture on Android/iOS cannot land back on the stale pre-update page.
  const reload = useCallback(() => {
    const target = deployedRef.current || BAKED_SHA;
    // Record the version we are updating to, so a bundle still served from a
    // cache does not re-trigger the banner on the next launch.
    if (target) {
      knownRef.current = target;
      writeStoredSha(target);
    }
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(Date.now()));
    window.location.replace(url.toString());
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
