"use client";

/**
 * Cross-browser PWA install detection.
 *
 * Only Chromium on Android (Chrome, Edge, Opera, Samsung Internet) fires the
 * `beforeinstallprompt` event, so it is the only case where we can show a
 * native install dialog. Brave is Chromium-based but frequently does not fire
 * the event and installs as a plain home-screen shortcut, and Firefox Android
 * never fires it. Every browser on iOS uses WebKit, where installation is
 * always the manual Share -> Add to Home Screen flow (Safari, Chrome, Brave,
 * Firefox and Edge included).
 *
 * This module centralises OS/browser detection and the matching instructions so
 * the in-app banner and the marketing Downloads page stay consistent.
 */

export type InstallOS = "android" | "ios" | "desktop";

export type InstallBrowser =
  | "chrome"
  | "brave"
  | "edge"
  | "opera"
  | "samsung"
  | "firefox"
  | "duckduckgo"
  | "safari"
  | "other";

/** Display name used in copy (e.g. "Chrome", "Brave"). */
export const BROWSER_LABEL: Record<InstallBrowser, string> = {
  chrome: "Chrome",
  brave: "Brave",
  edge: "Edge",
  opera: "Opera",
  samsung: "Samsung Internet",
  firefox: "Firefox",
  duckduckgo: "DuckDuckGo",
  safari: "Safari",
  other: "browser",
};

export function detectOS(ua: string): InstallOS {
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

export function detectBrowser(ua: string): InstallBrowser {
  const u = (ua || "").toLowerCase();
  // Brave hides its name from the UA string, so the reliable signal is the
  // `navigator.brave` object. Check it (and the UA token) before Chrome.
  if (hasBraveObject() || /\bbrave\b/.test(u)) return "brave";
  // Edge, Opera and Samsung all also contain "chrome", so match them first.
  if (/\bedg(a|ios|\/)/.test(u)) return "edge";
  if (/\bopr\/|\bopera\b/.test(u)) return "opera";
  if (/samsungbrowser/.test(u)) return "samsung";
  if (/fxios/.test(u) || /\bfirefox\b/.test(u)) return "firefox";
  if (/duckduckgo/.test(u)) return "duckduckgo";
  if (/crios/.test(u) || /\bchrome\b|\bchromium\b/.test(u)) return "chrome";
  if (/\bsafari\b/.test(u)) return "safari";
  return "other";
}

function hasBraveObject(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
  return typeof nav.brave?.isBrave === "function";
}

/**
 * True when the app is already running as an installed PWA (standalone,
 * fullscreen or minimal-ui), so install prompts must be hidden.
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    for (const mode of ["standalone", "fullscreen", "minimal-ui"] as const) {
      if (window.matchMedia(`(display-mode: ${mode})`).matches) return true;
    }
  } catch {
    /* matchMedia unavailable */
  }
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export interface InstallGuide {
  /** Whether this browser can show a native install dialog (Chromium Android). */
  native: boolean;
  /** Short instruction headline. */
  title: string;
  /** Ordered manual steps shown when no native dialog is available. */
  steps: string[];
}

/**
 * Chromium Android browsers that reliably fire `beforeinstallprompt` and can
 * install a real WebAPK once the app meets the installability criteria (the
 * service worker must expose a `fetch` listener - see `public/sw.js`).
 *
 * Brave and Firefox intentionally never get a native dialog: Brave suppresses
 * the event and installs a plain shortcut, Firefox Android has no PWA install.
 */
const NATIVE_ANDROID_BROWSERS: InstallBrowser[] = ["chrome", "edge", "opera", "samsung"];

/**
 * Whether we may show our own native "Install" button for this OS/browser.
 * On desktop the event firing is itself the signal; on Android it only counts
 * for the browsers that actually support WebAPK install.
 */
export function supportsNativePrompt(os: InstallOS, browser: InstallBrowser): boolean {
  if (os === "android") return NATIVE_ANDROID_BROWSERS.includes(browser);
  if (os === "ios") return false;
  return true;
}

/**
 * Browser-specific install instructions. `native` is advisory - the caller
 * still needs the captured `beforeinstallprompt` to actually show the dialog.
 */
export function installGuide(os: InstallOS, browser: InstallBrowser): InstallGuide {
  if (os === "ios") {
    const where: Record<InstallBrowser, string> = {
      safari: "at the bottom of the screen",
      chrome: "in the toolbar",
      brave: "under the menu",
      firefox: "under the menu",
      edge: "under the menu",
      opera: "under the menu",
      samsung: "in the toolbar",
      duckduckgo: "under the menu",
      other: "in the toolbar",
    };
    const shareHint =
      browser === "safari" || browser === "chrome" || browser === "samsung"
        ? "Tap the Share button"
        : "Open the menu, then tap Share";
    return {
      native: false,
      title: "Add Prysm Note to your Home Screen",
      steps: [
        `${shareHint} (${where[browser]}).`,
        "Scroll down and tap Add to Home Screen.",
        "Tap Add - the Prysm Note icon appears on your Home Screen.",
      ],
    };
  }

  if (os === "android") {
    const native = NATIVE_ANDROID_BROWSERS.includes(browser);
    if (native) {
      return {
        native: true,
        title: "Install Prysm Note on your phone",
        steps: [
          "Tap the in-app Install button, or open the browser menu and choose Install app (Chrome/Edge).",
          "Confirm with Install when the browser asks.",
          "The Prysm Note icon appears on your Home Screen and in your app drawer.",
        ],
      };
    }
    // Brave and Firefox never show a native dialog, so the manual steps must be
    // explicit about where the option lives (Brave hides it when the site looks
    // installable, and it can be turned off in Brave's menu customiser).
    if (browser === "brave") {
      return {
        native: false,
        title: "Add Prysm Note to your Home screen in Brave",
        steps: [
          "Tap the three-dot menu.",
          'Tap "Install and create shortcut" (older Brave builds show "Add to Home screen"), then tap the Install app button.',
          "If that item is missing, open the menu, tap Customize menu, and turn it on. The Prysm Note icon then appears on your Home screen.",
        ],
      };
    }
    if (browser === "firefox") {
      return {
        native: false,
        title: "Add Prysm Note to your Home screen in Firefox",
        steps: [
          "Tap the three-dot menu.",
          "Tap Add to Home screen, then confirm with Add.",
          "Firefox adds a shortcut to your Home Screen. For a full-screen app, use Chrome or Edge.",
        ],
      };
    }
    const menu: Partial<Record<InstallBrowser, string>> = {
      duckduckgo: "Tap the menu, then Add to Home screen.",
      safari: "Tap the menu, then Add to Home screen.",
      other: "Open the browser menu, then choose Install app or Add to Home screen.",
    };
    return {
      native: false,
      title: "Add Prysm Note to your Home screen",
      steps: [
        menu[browser] ?? "Open the browser menu, then choose Install app or Add to Home screen.",
        "Confirm by tapping Add.",
        "The Prysm Note icon appears on your Home Screen.",
      ],
    };
  }

  return {
    native: false,
    title: "Open Prysm Note on your phone",
    steps: ["Open prysmnote.com on your phone to install the app."],
  };
}
