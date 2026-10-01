"use client";

import type { StickyNote } from "@/lib/notes";

/**
 * Thin typed wrapper around the Electron bridge (`window.prysmDesktop`,
 * installed by the desktop shell's preload script).
 *
 * Everything here is feature-detected: the same bundle runs as a PWA in any
 * browser or inside Capacitor, where `window.prysmDesktop` is undefined and
 * every call is a safe no-op.
 */
export interface DesktopBridge {
  platform: string;
  isDesktop: boolean;
  minimize: () => void;
  maximizeToggle: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (maximized: boolean) => void) => void;
  /** Windows/Linux only: recolor the native title-bar overlay to match the theme. */
  setTitleBarOverlay?: (options: { color?: string; symbolColor?: string }) => void;
  startSso?: (provider: "google" | "github") => Promise<boolean>;
  startPasskey?: () => Promise<boolean>;
  /**
   * Desktop only: run an integration OAuth (Slack, GitHub, Gmail, Google
   * Calendar) in the system browser and deep-link back when it finishes.
   */
  startIntegrationConnect?: (provider: string, url: string) => Promise<boolean>;
  /** Desktop only: show a real OS notification (task reminders, due alerts). */
  showNotification?: (payload: {
    title: string;
    body?: string;
    silent?: boolean;
  }) => Promise<boolean> | void;
  /** Native sticky note windows (always-on-top, frameless mini-windows) */
  sticky?: {
    create: (noteData: {
      noteId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      title: string;
      content: string;
      minimized: boolean;
      alwaysOnTop: boolean;
    }) => Promise<string>;
    close: (windowId: string) => Promise<void>;
    update: (windowId: string, patch: Partial<StickyNote> & { alwaysOnTop?: boolean }) => Promise<void>;
    setAlwaysOnTop: (windowId: string, onTop: boolean) => Promise<void>;
    getAll: () => Promise<Array<{
      windowId: string;
      noteId: string;
      bounds: { x: number; y: number; width: number; height: number };
      alwaysOnTop: boolean;
    }>>;
    getByNoteId: (noteId: string) => Promise<{
      windowId: string;
      noteId: string;
      bounds: { x: number; y: number; width: number; height: number };
      alwaysOnTop: boolean;
    } | null>;
    onClosed: (callback: (data: { windowId: string; noteId: string }) => void) => void;
    onNoteUpdated: (callback: (data: { noteId: string } & Partial<StickyNote>) => void) => void;
    onNoteMinimized: (callback: (data: { noteId: string }) => void) => void;
  };
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.prysmDesktop;
  if (!bridge || !bridge.isDesktop) return null;
  return bridge;
}

/** Height of the in-app desktop title strip (see DesktopTitlebar). */
export const DESKTOP_TITLEBAR_HEIGHT = 38;

/**
 * Height of the reserved window-control strip, or 0 outside the desktop shell.
 * Single source: the `--desktop-titlebar` variable that `body.desktop-shell`
 * sets (globals.css). Falls back to the shell class where custom properties are
 * not resolvable (jsdom, older engines).
 */
export function desktopTitlebarHeight(): number {
  if (typeof window === "undefined") return 0;
  const raw = Number.parseFloat(
    getComputedStyle(document.body).getPropertyValue("--desktop-titlebar")
  );
  if (Number.isFinite(raw) && raw > 0) return raw;
  return document.body.classList.contains("desktop-shell") ? DESKTOP_TITLEBAR_HEIGHT : 0;
}

/**
 * Minimum `top` for a floating overlay (popover, menu, tour tooltip) so it can
 * never cover the OS-drawn window controls. On macOS those traffic lights sit
 * inside the top-left of the window; on Windows/Linux the minimize/maximize/
 * close cluster sits in the same 38px strip. Outside the desktop shell the
 * caller's own minimum applies.
 */
export function minOverlayTop(fallback = 8): number {
  if (typeof window === "undefined") return fallback;
  const strip = desktopTitlebarHeight();
  return strip > 0 ? strip + fallback : fallback;
}

/**
 * True when the OS draws the window buttons itself (Electron's
 * `titleBarOverlay`). Signal 1 is the Window Controls Overlay API, but only when
 * it exposes a real titlebar rect: some Chromium browsers (Brave) define a
 * `navigator.windowControlsOverlay` stub on every page, and a presence check
 * would wrongly report native buttons there. Signal 2 is the CSS env var:
 * `env(titlebar-area-width, 0px)` resolves to the real titlebar width when the
 * overlay is active and to the fallback when it is not.
 *
 * Desktop builds older than that change are frameless: neither signal fires, so
 * the renderer must draw its own minimize/maximize/close controls - otherwise a
 * frameless window has no window buttons at all.
 */
export function hasWindowControlsOverlay(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const wco = (
    navigator as Navigator & {
      windowControlsOverlay?: { getTitlebarAreaRect?: () => DOMRect };
    }
  ).windowControlsOverlay;
  if (wco && typeof wco.getTitlebarAreaRect === "function") {
    try {
      const rect = wco.getTitlebarAreaRect();
      if (rect && rect.width > 0) return true;
    } catch {
      // Fall through to the CSS probe.
    }
  }
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;width:env(titlebar-area-width, 0px)";
    document.body.appendChild(probe);
    const width = Number.parseFloat(getComputedStyle(probe).width);
    probe.remove();
    return Number.isFinite(width) && width > 0;
  } catch {
    return false;
  }
}

/**
 * Start SSO from the Electron app. Google refuses OAuth inside embedded
 * webviews, so the main process opens the provider in the system browser and
 * receives the one-time code back on the `prysmnote://` deep link. Returns true
 * when the desktop bridge handled it (the caller must not fall back to the
 * in-window redirect); false in a browser/PWA so the normal redirect runs.
 */
export async function openDesktopSso(provider: "google" | "github"): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge?.startSso) return false;
  try {
    return await bridge.startSso(provider);
  } catch {
    return false;
  }
}

/**
 * Start the passkey ceremony from the Electron app. `navigator.credentials` is
 * unreliable in Electron's window on macOS, so the main process opens the login
 * page in the system browser (`?passkey=1&redirect=desktop&nonce=...`) and the
 * result returns on the `prysmnote://` deep link. Returns true when the bridge
 * handled it; false in a browser/PWA so the in-page ceremony runs.
 */
export async function openDesktopPasskey(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge?.startPasskey) return false;
  try {
    return await bridge.startPasskey();
  } catch {
    return false;
  }
}

/**
 * Connect an integration from the Electron app. Embedded webviews block the
 * provider consent screens and cannot hold the callback cookie, so the main
 * process opens the connect URL in the system browser and the page deep-links
 * back (`prysmnote://integration/callback`) when the round trip finishes.
 * Returns true when the bridge handled it; false in a browser/PWA so the
 * caller falls back to the normal in-window redirect.
 */
export async function openDesktopIntegrationConnect(
  provider: string,
  url: string
): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge?.startIntegrationConnect) return false;
  try {
    return await bridge.startIntegrationConnect(provider, url);
  } catch {
    return false;
  }
}

/**
 * Show a real OS notification from the Electron app. Returns true when the
 * bridge handled it; false in a browser/PWA so the caller can fall back to the
 * browser Notification API (or the in-app card stack).
 */
export function openDesktopNotification(payload: {
  title: string;
  body?: string;
  silent?: boolean;
}): boolean {
  const bridge = getDesktopBridge();
  if (!bridge?.showNotification) return false;
  try {
    void bridge.showNotification(payload);
    return true;
  } catch {
    return false;
  }
}