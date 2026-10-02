"use client";

/**
 * URL for the app's service worker. The build SHA is appended so a new deploy
 * registers a NEW script URL: the browser installs the updated worker and its
 * activate handler drops the previous release's caches (see public/sw.js).
 * Without this, the unchanging `/sw.js` never triggered an update, so a
 * previous release's cached shell/RSC could linger after a deploy. Falls back
 * to a stable "dev" version when no SHA is baked in (local dev).
 */
export const SW_URL = `/sw.js?v=${encodeURIComponent(
  process.env.NEXT_PUBLIC_GIT_SHA || "dev"
)}`;

/**
 * Register the service worker, if the browser supports it. Never throws: push
 * notifications and the offline shell are both best-effort.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    return null;
  }
}
