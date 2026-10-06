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

/** Exponential backoff for SSE reconnection (ms). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** Fallback polling interval when SSE is unavailable (ms). */
const POLL_INTERVAL_MS = 30000;

export function useRealtimeSync(onChange: () => void, enabled = true) {
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let openedBefore = false;
    let closed = false;

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        callbackRef.current();
      }, REALTIME_DEBOUNCE_MS);
    };

    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const startPolling = () => {
      if (pollInterval) return;
      pollInterval = setInterval(() => {
        callbackRef.current();
      }, POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (closed) return;

      try {
        source = new EventSource(`${API_URL}/events`, { withCredentials: true });
      } catch {
        startPolling();
        return;
      }

      source.addEventListener("change", schedule);

      source.addEventListener("open", () => {
        reconnectAttempts = 0;
        stopPolling();
        if (openedBefore) schedule();
        openedBefore = true;
      });

      source.addEventListener("error", () => {
        if (closed) return;
        source?.close();
        source = null;

        if (reconnectAttempts === 0) {
          startPolling();
        }

        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
          RECONNECT_MAX_MS
        );
        reconnectAttempts++;

        reconnectTimeout = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      stopPolling();
      if (source) {
        source.removeEventListener("change", schedule);
        source.close();
      }
    };
  }, [enabled]);
}
