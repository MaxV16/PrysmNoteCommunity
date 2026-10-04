"use client";

import { runBackHandler } from "@/lib/back-nav";

/**
 * Thin typed wrapper around the Capacitor native bridge (`window.Capacitor`,
 * injected by the Capacitor runtime into the WebView even when it loads the
 * remote app at `server.url`). Feature-detected like the desktop bridge: in a
 * plain browser/PWA `window.Capacitor` is undefined and every call is a safe
 * no-op.
 *
 * CRITICAL: the `@capacitor/*` npm packages live only in the private native app
 * shell, so this core module must NEVER statically import them - the core
 * frontend build would fail. It talks to the plugins through the
 * runtime-injected globals instead; the plugins are registered on the native
 * side by the shell's package.json + capacitor.config.ts.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

/**
 * Login-CSRF guard: the nonce for the SSO flow this app started. The backend
 * echoes it on the `com.prysmnote.app://` deep link and we reject any link that
 * does not carry it, so a stray/malicious deep link cannot sign the app into an
 * account the user did not authenticate as.
 */
let pendingSsoNonce: string | null = null;

/**
 * Login-CSRF guard for the integration-connect hand-off. A connect started in
 * the app opens the settings page in the system browser (Google blocks OAuth in
 * embedded webviews); when the provider round trip finishes there, that page
 * deep-links back with this nonce, and the WebView returns to Settings. Reject
 * any link that does not carry the nonce for the flow this app started.
 */
let pendingIntegrationNonce: string | null = null;

/** URL-safe random nonce (matches the backend's NONCE_RE: [A-Za-z0-9_-]{1,64}). */
function randomNonce(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
  pendingSsoNonce = randomNonce();
  const url = `${API_URL}/auth/oauth/${provider}/start?redirect=mobile&nonce=${encodeURIComponent(pendingSsoNonce)}`;
  await browser.open({ url });
  return true;
}

/**
 * Start an integration connect from the mobile app. Opens the app's own
 * Settings page in the system browser with a `redirect=mobile&connect=<provider>`
 * marker; that page fetches the provider URL, the consent finishes in the system
 * browser, and it deep-links back so the WebView can pick the result up.
 *
 * Returns true when the native browser was opened (the caller must not fall back
 * to navigating the WebView itself).
 */
export async function openMobileIntegrationConnect(provider: string, appUrl: string): Promise<boolean> {
  const c = getCapBridge();
  const browser = c?.Plugins?.Browser;
  if (!c || !browser?.open) return false;
  pendingIntegrationNonce = randomNonce();
  const sep = appUrl.includes("?") ? "&" : "?";
  const url = `${appUrl}${sep}redirect=mobile&connect=${encodeURIComponent(provider)}&nonce=${encodeURIComponent(pendingIntegrationNonce)}`;
  await browser.open({ url });
  return true;
}

/** True when `url` is the `com.prysmnote.app://integration/callback?...` return deep link. */
function handleIntegrationDeepLink(parsed: URL): boolean {
  if (parsed.host !== "integration" && !parsed.pathname.startsWith("/integration")) return false;
  const nonce = parsed.searchParams.get("nonce") ?? "";
  if (!pendingIntegrationNonce || nonce !== pendingIntegrationNonce) return true;
  pendingIntegrationNonce = null;
  const provider = parsed.searchParams.get("provider") ?? "";
  const params = new URLSearchParams({ tab: "integrations" });
  if (provider) params.set("connected", provider);
  // Reopen the app Settings in the WebView; the credential already lives on the
  // server, so the row just refreshes.
  window.location.href = `${window.location.origin}/settings?${params.toString()}`;
  return true;
}


/**
 * Handle a `com.prysmnote.app://` deep link: either the integration-connect
 * return (`://integration/callback`) or the SSO code exchange (`://oauth/...`).
 * Exported for tests; the app wires it to the native `appUrlOpen` event.
 */
export function handleMobileUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "com.prysmnote.app:") return;
    if (handleIntegrationDeepLink(parsed)) return;
    const code = parsed.searchParams.get("code");
    if (!code) return;
    // Only accept the deep link for the flow this app started (login-CSRF).
    const nonce = parsed.searchParams.get("nonce") ?? "";
    if (!pendingSsoNonce || nonce !== pendingSsoNonce) return;
    pendingSsoNonce = null;
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

  // SSO and integration-connect deep links (`com.prysmnote.app://...`) after the
  // user finishes consent in the system browser.
  void c.Plugins.App.addListener("appUrlOpen", (event) => {
    handleMobileUrl(String(event?.url ?? ""));
  });

  // Hardware/systems back button: first let the in-app back stack close the
  // top-most overlay or leave a workspace, then fall back to history back, then
  // background the app. Without the in-app step, back exited the app even when a
  // modal/drawer or a non-timeline workspace was open.
  void c.Plugins.App.addListener("backButton", () => {
    if (runBackHandler()) return;
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