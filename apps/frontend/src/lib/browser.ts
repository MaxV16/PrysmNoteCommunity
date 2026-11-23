"use client";

/**
 * OS detection for mobile-aware UI.
 *
 * The app no longer offers a browser install flow: Android ships through Google
 * Play and iPhone/iPad use the web app. This helper only answers "which kind of
 * device is this" so the UI can keep desktop-only surfaces out of phones.
 */

export type DeviceOS = "android" | "ios" | "desktop";

export function detectOS(ua: string): DeviceOS {
  if (!ua) return "desktop";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPadOS 13+ masquerades as desktop Safari; a multi-touch Mac is really an iPad.
  if (
    /macintosh/i.test(ua) &&
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints ?? 0) > 1
  ) {
    return "ios";
  }
  if (/android/i.test(ua)) return "android";
  return "desktop";
}
