"use client";

import { track } from "@/lib/track";

// Sample 1 in N errors so the client-side error volume stays bounded while
// still surfacing representative failures. Error payloads never include
// credentials or sensitive values - only the message, source and a truncated
// stack (both already rendered by the browser for the current page).
const ERROR_SAMPLE_RATE = 20;

function maybeTrackError(message: string, source: string | undefined, stack: string | undefined): void {
  if (Math.floor(Math.random() * ERROR_SAMPLE_RATE) !== 0) return;
  track("error_event", {
    message: (message || "").slice(0, 500),
    source: (source || "").slice(0, 300),
    stack: (stack || "").slice(0, 1500),
  });
}

export function initErrorTracking(): void {
  if (typeof window === "undefined") return;
  if ((window as unknown as { __prysmErrorTrackInit?: boolean }).__prysmErrorTrackInit) return;
  (window as unknown as { __prysmErrorTrackInit?: boolean }).__prysmErrorTrackInit = true;

  window.addEventListener("error", (event) => {
    maybeTrackError(event.message, event.filename, event.error?.stack);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    maybeTrackError(message, undefined, reason instanceof Error ? reason.stack : undefined);
  });
}
