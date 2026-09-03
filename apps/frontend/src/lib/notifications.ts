"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface NotificationPrefs {
  email_reminders: boolean;
  due_alerts: boolean;
  email_digest: boolean;
  push_enabled: boolean;
  sound: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  email_reminders: true,
  due_alerts: true,
  email_digest: false,
  push_enabled: false,
  sound: true,
};

const SOUND_KEY = "prysm_notif_sound";

export function setSoundLocal(value: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(value));
  } catch {}
}

export async function registerServiceWorker(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register("/sw.js");
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribe the current browser to Web Push using the backend's VAPID key, then
 * persist the subscription. Returns true on success.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const sw = await registerServiceWorker();
    if (!sw) return false;
    const reg = await navigator.serviceWorker.ready;
    const { public_key } = await api.get<{ public_key: string }>("/notifications/vapid-public-key");
    if (!public_key) return false;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyBytes = Uint8Array.from(atob(public_key), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes,
      });
    }
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys) return false;
    await api.post("/notifications/subscribe", {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
    return true;
  } catch {
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && sub.toJSON().endpoint) {
      await api.delete(`/notifications/subscribe?endpoint=${encodeURIComponent(sub.toJSON().endpoint!)}`);
    }
    if (sub) await sub.unsubscribe();
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-backed notification prefs with a localStorage fallback so the app works
 * offline. The `sound` value is mirrored to `prysm_notif_sound` (read by the
 * task-completion sound gate).
 */
export function useNotificationPrefs() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => {
    if (typeof window === "undefined") return DEFAULT_PREFS;
    try {
      const raw = localStorage.getItem(SOUND_KEY);
      return { ...DEFAULT_PREFS, sound: raw === null ? true : raw === "true" };
    } catch {
      return DEFAULT_PREFS;
    }
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Partial<NotificationPrefs>>("/notifications/prefs")
      .then((data) => {
        if (cancelled) return;
        setPrefs((prev) => ({ ...prev, ...data }));
        if (data.sound !== undefined) setSoundLocal(data.sound);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<NotificationPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      if (patch.sound !== undefined) setSoundLocal(next.sound);
      return next;
    });
    try {
      const saved = await api.patch<NotificationPrefs>("/notifications/prefs", patch);
      setPrefs((prev) => ({ ...prev, ...saved }));
      setSoundLocal(saved.sound);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { prefs, update, loaded };
}
