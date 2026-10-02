"use client";

import { useEffect, useRef } from "react";

/**
 * Server-sent events stream. The backend publishes a lightweight change event
 * whenever this user mutates tasks, tags, lists, sections, notes, preferences,
 * watchlist, habits or finance, so other devices (and other tabs) refresh
 * immediately instead of waiting for the next poll tick.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

/** Collapse a burst of change events (a batch edit publishes several) into one. */
const REALTIME_DEBOUNCE_MS = 1500;

export function useRealtimeSync(onChange: () => void, enabled = true) {
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;
    // The stream also emits `open` after an automatic reconnect; the first
    // open is the initial connection (the mount fetch already covers it), so
    // only a later open (i.e. a recovered stream) forces a catch-up refresh.
    let openedBefore = false;

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        callbackRef.current();
      }, REALTIME_DEBOUNCE_MS);
    };

    const onOpen = () => {
      if (openedBefore) schedule();
      openedBefore = true;
    };

    try {
      source = new EventSource(`${API_URL}/events`, { withCredentials: true });
      source.addEventListener("change", schedule);
      source.addEventListener("open", onOpen);
    } catch {
      // EventSource unsupported or blocked; the foreground interval still runs.
      return;
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (source) {
        source.removeEventListener("change", schedule);
        source.removeEventListener("open", onOpen);
        source.close();
      }
    };
  }, [enabled]);
}
