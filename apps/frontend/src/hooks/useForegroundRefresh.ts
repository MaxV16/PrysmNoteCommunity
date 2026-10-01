"use client";

import { useEffect, useRef } from "react";

/** Broadcast on foreground return so any mounted view can reload its own data. */
export const FOREGROUND_REFRESH_EVENT = "prysm-foreground-refresh";

/** Bursts of focus + visibilitychange collapse into one refresh. */
const MIN_GAP_MS = 5000;

/**
 * Runs `callback` when the app returns to the foreground (the tab becomes
 * visible or the window regains focus) and on a bounded interval while the
 * document is visible, so changes made on another device appear without a
 * manual reload.
 *
 * Hidden documents never fire and rapid events are de-duped. The interval is a
 * slow safety net (default 5 min): live changes arrive over SSE
 * (`useRealtimeSync`), so this only re-syncs after a dropped stream or a long
 * idle period, keeping the single small prod VM quiet.
 */
export function useForegroundRefresh(
  callback: () => void | Promise<void>,
  options?: { intervalMs?: number }
) {
  const intervalMs = options?.intervalMs ?? 300000;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    let last = 0;

    const run = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      void callbackRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };
    const onFocus = () => run();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(run, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [intervalMs]);
}
