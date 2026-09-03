"use client";

import { ensureCsrf, getCsrfToken, CSRF_HEADER } from "@/lib/csrf";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

const SESSION_KEY = "prysm_session_id";
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER = 10;

let buffer: Array<{ event: string; properties?: Record<string, unknown> }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function trackSessionStart(): string {
  const existing = getSessionId();
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    // storage unavailable; the session id is still used for this page load
  }
  return id;
}

export function __resetTrackStateForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  buffer = [];
}

async function postEvent(
  event: string,
  properties: Record<string, unknown>,
  sessionId: string | null,
  csrf: string | null
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${API_URL}/analytics/track`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      },
      body: JSON.stringify({
        event,
        properties: properties || {},
        session_id: sessionId,
      }),
      signal: controller.signal,
    });
  } catch {
    // Silent: analytics must never surface errors or log noise.
  } finally {
    window.clearTimeout(timeout);
  }
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const sessionId = getSessionId();
  try {
    // Fire-and-forget with a hard timeout: tracking must never hold up or fail
    // the UI, and a slow analytics endpoint must not pile up requests. Every
    // buffered event is posted individually so none are silently dropped.
    await ensureCsrf();
    const csrf = getCsrfToken();
    for (const item of batch) {
      await postEvent(item.event, item.properties || {}, sessionId, csrf);
    }
  } catch {
    // Silent: analytics must never surface errors or log noise.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Record a first-party product event. Silent and fire-and-forget: failures are
 * swallowed, nothing redirects, and the buffer never grows unbounded (it is
 * flushed on a timer and capped at MAX_BUFFER events before an eager flush).
 * A session id is created lazily on the first event (so analytics never runs
 * for a fully logged-out visitor).
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (!getSessionId()) trackSessionStart();
  buffer.push({ event, properties });
  if (buffer.length >= MAX_BUFFER) {
    void flush();
  } else {
    scheduleFlush();
  }
}

// Flush whatever is buffered when the tab is hidden (visibilitychange), so
// events recorded just before navigation are not lost.
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}
