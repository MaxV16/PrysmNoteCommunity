"use client";

import { runBackHandler } from "@/lib/back-nav";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";

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

type PermissionDisplay = "prompt" | "prompt-with-rationale" | "granted" | "denied";

interface LocalNotificationSchema {
  id: number;
  title: string;
  body: string;
  channelId?: string;
  extra?: Record<string, unknown>;
  schedule?: { at: Date; allowWhileIdle?: boolean };
}

interface PendingLocalNotification {
  id: number;
  extra?: Record<string, unknown>;
}

interface LocalNotificationsPlugin extends CapPlugin {
  checkPermissions?: () => Promise<{ display?: PermissionDisplay }>;
  requestPermissions?: () => Promise<{ display?: PermissionDisplay }>;
  createChannel?: (channel: {
    id: string;
    name: string;
    description?: string;
    importance: number;
    visibility?: number;
    vibration?: boolean;
    lights?: boolean;
  }) => Promise<void>;
  schedule?: (options: { notifications: LocalNotificationSchema[] }) => Promise<unknown>;
  cancel?: (options: { notifications: { id: number }[] }) => Promise<void>;
  getPending?: () => Promise<{ notifications?: PendingLocalNotification[] }>;
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
    LocalNotifications?: LocalNotificationsPlugin;
  };
}

function getCapBridge(): CapBridge | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { Capacitor?: CapBridge }).Capacitor;
  if (!c || typeof c.isNativePlatform !== "function" || !c.isNativePlatform()) return null;
  return c;
}

// ---------------------------------------------------------------------------
// Local (OS) notifications for per-task reminders on Android / iOS.
//
// The native shell carries `@capacitor/local-notifications`, so a reminder can
// be handed to the OS and still fire when the app is closed. No FCM/APNs
// credentials are involved: these are device-local scheduled notifications.
// ---------------------------------------------------------------------------

const ANDROID_REMINDER_CHANNEL = "prysm-reminders";
const RECONCILE_LIMIT = 64;
let reminderChannelReady = false;

/** The LocalNotifications plugin, or null outside the native shell. */
function getLocalNotifications(): LocalNotificationsPlugin | null {
  const c = getCapBridge();
  const plugin = c?.Plugins?.LocalNotifications;
  if (!plugin || typeof plugin.schedule !== "function") return null;
  return plugin;
}

/** Stable positive 31-bit notification id derived from a task id. */
export function reminderNotificationId(taskId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < taskId.length; i += 1) {
    hash ^= taskId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2147483647) || 1;
}

/** True when this build runs in a native shell that can schedule OS reminders. */
export function nativeNotificationsSupported(): boolean {
  return getLocalNotifications() !== null;
}

async function permissionGranted(plugin: LocalNotificationsPlugin): Promise<boolean> {
  try {
    const status = await plugin.checkPermissions?.();
    return status?.display === "granted";
  } catch {
    return false;
  }
}

async function ensureReminderChannel(plugin: LocalNotificationsPlugin): Promise<void> {
  if (reminderChannelReady) return;
  try {
    await plugin.createChannel?.({
      id: ANDROID_REMINDER_CHANNEL,
      name: "Task reminders",
      description: "Per-task reminders scheduled in Prysm Note",
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    reminderChannelReady = true;
  } catch {
    // No channel API on iOS (or an old shell): scheduling still works.
  }
}

/**
 * Ask the OS for notification permission (call from a user gesture, e.g. when
 * the "Device" channel is selected). Returns true when allowed. Never throws.
 */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  const plugin = getLocalNotifications();
  if (!plugin) return false;
  try {
    let display = (await plugin.checkPermissions?.())?.display;
    if (display !== "granted") {
      display = (await plugin.requestPermissions?.())?.display ?? display;
    }
    if (display === "granted") {
      await ensureReminderChannel(plugin);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface NativeReminderInput {
  taskId: string;
  title: string;
  body?: string;
  /** ISO 8601 instant when the reminder should fire. */
  at: string;
}

/**
 * Schedule a one-off OS reminder. No-op (returns false) outside a native shell,
 * without permission, for a past time, or when the plugin call fails.
 */
export async function scheduleNativeReminder(input: NativeReminderInput): Promise<boolean> {
  const plugin = getLocalNotifications();
  if (!plugin) return false;
  const when = new Date(input.at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return false;
  // Never prompt from a background sync: only schedule once the user granted it.
  if (!(await permissionGranted(plugin))) return false;
  await ensureReminderChannel(plugin);
  try {
    await plugin.schedule?.({
      notifications: [
        {
          id: reminderNotificationId(input.taskId),
          title: input.title || "Prysm Note",
          body: input.body || "Task reminder",
          channelId: ANDROID_REMINDER_CHANNEL,
          extra: { taskId: input.taskId, prysm: true },
          schedule: { at: when, allowWhileIdle: true },
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel the OS reminder for a task, if one is scheduled. */
export async function cancelNativeReminder(taskId: string): Promise<void> {
  const plugin = getLocalNotifications();
  if (!plugin) return;
  try {
    await plugin.cancel?.({ notifications: [{ id: reminderNotificationId(taskId) }] });
  } catch {
    // Nothing scheduled (or an old shell without cancel): nothing to undo.
  }
}

export interface NativeReminderRow {
  id: string;
  title: string;
  reminder_at: string;
}

/**
 * Make the OS schedule match the server's upcoming reminders: cancel Prysm
 * notifications that are no longer upcoming, then (re)schedule the rest. Runs
 * on native startup and foreground refresh, bounded to RECONCILE_LIMIT entries.
 */
export async function reconcileNativeReminders(rows: NativeReminderRow[]): Promise<void> {
  const plugin = getLocalNotifications();
  if (!plugin) return;
  if (!(await permissionGranted(plugin))) return;

  const now = Date.now();
  const upcoming = (rows || [])
    .filter((row) => {
      if (!row || typeof row.id !== "string" || !row.reminder_at) return false;
      const at = new Date(row.reminder_at).getTime();
      return !Number.isNaN(at) && at > now;
    })
    .slice(0, RECONCILE_LIMIT);
  const wanted = new Set(upcoming.map((row) => reminderNotificationId(row.id)));

  try {
    const pending = (await plugin.getPending?.())?.notifications ?? [];
    const stale = pending.filter(
      (item) => item.extra?.prysm === true && !wanted.has(item.id)
    );
    if (stale.length > 0) {
      await plugin.cancel?.({ notifications: stale.map((item) => ({ id: item.id })) });
    }
    if (upcoming.length === 0) return;
    await ensureReminderChannel(plugin);
    await plugin.schedule?.({
      notifications: upcoming.map((row) => ({
        id: reminderNotificationId(row.id),
        title: row.title || "Prysm Note",
        body: "Tap to open the task",
        channelId: ANDROID_REMINDER_CHANNEL,
        extra: { taskId: row.id, prysm: true },
        schedule: { at: new Date(row.reminder_at), allowWhileIdle: true },
      })),
    });
  } catch {
    // A failed reconcile must never break the app; the next refresh retries.
  }
}

/** Task shape needed to keep its OS reminder in sync. */
export interface NativeReminderTask {
  id: string;
  title: string;
  status: string;
  reminder_enabled?: boolean;
  reminder_at?: string | null;
  reminder_push?: boolean;
}

/**
 * Apply a saved task's reminder to the OS schedule. Active reminders (opt-in,
 * future, Device channel, task not done/cancelled) are scheduled; everything
 * else is cancelled so clearing or completing a task stops its notification.
 */
export async function syncNativeReminderForTask(task: NativeReminderTask): Promise<void> {
  if (!nativeNotificationsSupported()) return;
  const at = task.reminder_at ? new Date(task.reminder_at) : null;
  const active =
    Boolean(task.reminder_enabled) &&
    Boolean(task.reminder_push) &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    !!at &&
    !Number.isNaN(at.getTime()) &&
    at.getTime() > Date.now();
  if (!active) {
    await cancelNativeReminder(task.id);
    return;
  }
  await scheduleNativeReminder({
    taskId: task.id,
    title: task.title,
    body: "Tap to open the task",
    at: task.reminder_at as string,
  });
}

/** Open a task from a tapped OS notification (fetching it outside the window). */
export async function openTaskFromReminder(taskId: string): Promise<void> {
  if (!taskId) return;
  if (!useAppStore.getState().tasks.some((task) => task.id === taskId)) {
    try {
      const task = await api.get<Task>(`/tasks/${taskId}`);
      if (task) useAppStore.getState().mergeTasks([task]);
    } catch {
      // The drawer treats an unknown id as a no-op; nothing else to do.
    }
  }
  useAppStore.getState().setSelectedTaskId(taskId);
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

  // Tapping an OS reminder opens its task. The payload id rides in `extra`, so
  // a notification for a task outside the loaded timeline window still resolves.
  const localNotifications = c.Plugins.LocalNotifications;
  if (localNotifications) {
    void localNotifications.addListener("localNotificationActionPerformed", (event) => {
      const notification = event?.notification as
        | { extra?: Record<string, unknown> }
        | undefined;
      const taskId = notification?.extra?.taskId;
      if (typeof taskId === "string" && taskId) {
        void openTaskFromReminder(taskId);
      }
    });
  }

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