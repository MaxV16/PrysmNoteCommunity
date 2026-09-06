"use client";

/**
 * Thin typed wrapper around the Capacitor native bridge (`window.Capacitor`,
 * injected by the Capacitor runtime into the WebView even when it loads the
 * remote app at `server.url`). Feature-detected like the desktop bridge: in a
 * plain browser/PWA `window.Capacitor` is undefined and every call is a safe
 * no-op.
 *
 * CRITICAL: the `@capacitor/*` npm packages live in `ee/apps/mobile` (and only
 * there), so this core module must NEVER statically import them - the core
 * frontend build would fail. It talks to the plugins through the
 * runtime-injected globals instead; the plugins are registered on the native
 * side via `ee/apps/mobile/package.json` + `capacitor.config.ts`.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

interface CapPlugin {
  addListener: (eventName: string, listener: (event: Record<string, unknown>) => void) => Promise<unknown>;
}

interface CapBridge {
  isNativePlatform: () => boolean;
  Plugins: {
    App: CapPlugin & { exitApp?: () => void };
    Browser?: CapPlugin & {
      open?: (options: { url: string }) => Promise<void>;
      addListener?: (eventName: string, listener: (event: Record<string, unknown>) => void) => Promise<unknown>;
    };
    StatusBar?: CapPlugin & { setStyle?: (options: { style: "DARK" | "LIGHT" }) => Promise<void> };
    Keyboard?: CapPlugin;
  };
}

function getCapBridge(): CapBridge | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { Capacitor?: CapBridge }).Capacitor;
  if (!c || typeof c.isNativePlatform !== "function" || !c.isNativePlatform()) return null;
  return c;
}

/** True when running inside the Capacitor WebView (not the browser/PWA/Electron). */
export function isNative(): boolean {
  return getCapBridge() !== null;
}

/**
 * Start the SSO flow in the system browser instead of the WebView. Google
 * prohibits OAuth sign-in inside embedded webviews, so the backend issues a
 * one-time code (`redirect=mobile`) and bounces back to the app's deep link;
 * `initCapbridge` picks the code up and exchanges it inside the WebView.
 *
 * Returns true when the native browser was opened (caller should not fall back
 * to the plain in-WebView redirect).
 */
export async function openMobileSso(provider: "google" | "github"): Promise<boolean> {
  const c = getCapBridge();
  const browser = c?.Plugins?.Browser;
  if (!c || !browser?.open) return false;
  const url = `${API_URL}/auth/oauth/${provider}/start?redirect=mobile`;
  await browser.open({ url });
  return true;
}

function exchangeMobileCode(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "com.prysmnote.app:") return;
    const code = parsed.searchParams.get("code");
    if (!code) return;
    // Loading this inside the WebView sets the session cookies there, then
    // 307s to the app root so the app is authenticated on resume.
    window.location.href = `${window.location.origin}/api/auth/mobile/exchange?code=${encodeURIComponent(code)}`;
  } catch {
    // Malformed deep link - ignore so the app never throws on resume.
  }
}

/**
 * Wire the native bridges once at startup (call from the root layout). Safe
 * to call in any environment: outside the WebView it is a no-op.
 */
export function initCapbridge(): void {
  const c = getCapBridge();
  if (!c) return;

  // SSO deep link (`com.prysmnote.app://oauth/client?code=...`) after the user
  // finishes consent in the system browser.
  void c.Plugins.App.addListener("appUrlOpen", (event) => {
    exchangeMobileCode(String(event?.url ?? ""));
  });

  // Hardware/systems back button: history back when possible, else background the app.
  void c.Plugins.App.addListener("backButton", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else if (c.Plugins.App.exitApp) {
      c.Plugins.App.exitApp();
    }
  });

  // Keyboard resize: tag the root element (CSS hooks) and nudge the focused
  // input into view so the composer never hides behind the keyboard.
  const keyboard = c.Plugins.Keyboard;
  if (keyboard) {
    void keyboard.addListener("keyboardWillShow", () => {
      document.documentElement.classList.add("cap-keyboard-open");
      requestAnimationFrame(() => {
        const el = document.activeElement;
        if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
          (el as HTMLElement).scrollIntoView({ block: "nearest" });
        }
      });
    });
    void keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.classList.remove("cap-keyboard-open");
    });
  }

  // Theme-aware status bar (the app toggles `.dark` on <html>).
  const applyStatusBarStyle = () => {
    const dark = document.documentElement.classList.contains("dark");
    void c.Plugins.StatusBar?.setStyle?.({ style: dark ? "DARK" : "LIGHT" });
  };
  applyStatusBarStyle();
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyStatusBarStyle);
    } catch {
      // Older WebViews - the initial style still applied above.
    }
  }
}