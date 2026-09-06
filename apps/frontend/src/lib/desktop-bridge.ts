"use client";

/**
 * Thin typed wrapper around the Electron bridge (`window.prysmDesktop`,
 * installed by ee/apps/desktop/electron/preload.js).
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
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.prysmDesktop;
  if (!bridge || !bridge.isDesktop) return null;
  return bridge;
}

/** True when running inside the Electron shell (not the browser/PWA). */
export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}

export function isMacOS(): boolean {
  const bridge = getDesktopBridge();
  return bridge !== null && bridge.platform === "darwin";
}