"use client";

/**
 * In-app back stack for the Android/hardware back button (and any future
 * browser-back integration). Overlays and workspaces register a handler while
 * they are open; the native back listener in `capbridge.ts` runs the top-most
 * handler first, so back closes the current thing instead of immediately
 * leaving the WebView.
 *
 * Handlers carry a priority: interactive overlays (modals, drawers, expanded
 * panels) use a high priority and workspace-level navigation a low one, so the
 * ordering is correct even though React runs child effects before parent ones.
 * Within the same priority the most recently registered handler wins.
 */

type BackHandler = () => void;

interface BackEntry {
  handler: BackHandler;
  priority: number;
}

const entries: BackEntry[] = [];

/**
 * Register a back handler. Returns an unregister function (call it in the
 * effect cleanup). `priority`: higher runs first; default 0.
 */
export function registerBackHandler(handler: BackHandler, priority = 0): () => void {
  const entry: BackEntry = { handler, priority };
  entries.push(entry);
  return () => {
    const i = entries.lastIndexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  };
}

/** Run the highest-priority back handler. Returns true when one handled it. */
export function runBackHandler(): boolean {
  if (entries.length === 0) return false;
  // Stable sort ascending by priority, so the last entry is the top-most.
  const ordered = [...entries].sort((a, b) => a.priority - b.priority);
  ordered[ordered.length - 1].handler();
  return true;
}

/** True when at least one in-app back handler is registered. */
export function hasBackHandlers(): boolean {
  return entries.length > 0;
}
