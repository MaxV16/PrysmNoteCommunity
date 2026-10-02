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

// A running bundle that references a chunk the new deploy has replaced fails to
// load it ("Loading chunk N failed", "Failed to fetch dynamically imported
// module"). Today Next.js surfaces this as a broken screen rather than a
// reload, so the banner is the safe recovery: reload to the fresh build.
const CHUNK_ERROR_RE =
  /Loading chunk [^ ]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function isChunkLoadError(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "string") return CHUNK_ERROR_RE.test(value);
  const err = value as { name?: unknown; message?: unknown };
  if (err.name === "ChunkLoadError") return true;
  return typeof err.message === "string" && CHUNK_ERROR_RE.test(err.message);
}

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
    // A cheap prompt on return to the foreground: no new timer, just one
    // /version fetch when the tab becomes visible or focused, so the refresh
    // prompt appears promptly after a deploy that happened while the tab was
    // hidden. The focus + visibility pair collapses into a single request.
    let lastForegroundCheck = 0;
    const onForeground = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastForegroundCheck < 2000) return;
      lastForegroundCheck = now;
      void check();
    };
    const onVisibility = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        onForeground();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onForeground);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onForeground);
    };
  }, [user, check]);

  // Service worker handoff: a fresh worker takes control of an already-open tab
  // via skipWaiting + clients.claim, but the tab is NOT reloaded, so it keeps
  // executing the OLD bundle. That is exactly the window in which a just-fixed
  // bug can still run. React to the handoff immediately by re-checking /version
  // so the refresh prompt shows at once rather than up to POLL_INTERVAL_MS
  // later. The signal only triggers a check - it never reloads or ends a
  // session; the reload stays an explicit user action.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const sw = navigator.serviceWorker;
    // On first load the worker claims the page through clients.claim(), which
    // fires controllerchange even though nothing was replaced. Only an already
    // controlled page swapping controllers means a real new release.
    const hadController = Boolean(sw.controller);
    const onMessage = (event: MessageEvent) => {
      if (event.data && (event.data as { type?: string }).type === "SW_UPDATED") {
        void check();
      }
    };
    const onControllerChange = () => {
      if (hadController) void check();
    };
    sw.addEventListener("message", onMessage);
    sw.addEventListener("controllerchange", onControllerChange);
    return () => {
      sw.removeEventListener("message", onMessage);
      sw.removeEventListener("controllerchange", onControllerChange);
    };
  }, [check]);

  // A stale chunk after a deploy cannot finish loading the old bundle. Rather
  // than leave the user on a broken screen (or let the app silently thrash),
  // surface the update banner so the reload is explicit and keeps the session.
  // Only genuine chunk-load failures qualify; unrelated errors are ignored.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onError = (event: Event) => {
      // Capture phase also receives resource errors. A failed `/_next/static/`
      // script is the fingerprint of a chunk the new deploy has replaced, even
      // when the browser reports it on the element rather than as a runtime
      // error; check it before the generic ErrorEvent shape.
      const target = event.target as (HTMLElement & { src?: unknown }) | null;
      if (target && target !== (event.currentTarget as unknown)) {
        const src = typeof target.src === "string" ? target.src : "";
        if (src.includes("/_next/static/")) {
          setOutdated(true);
          return;
        }
      }
      const e = event as ErrorEvent;
      if (isChunkLoadError(e.error) || isChunkLoadError(e.message)) setOutdated(true);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) setOutdated(true);
    };
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

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
