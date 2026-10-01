"use client";

import { useCallback, useEffect, useState } from "react";
import { isStandalone } from "@/lib/browser";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * PWA install prompt capture. Chromium fires `beforeinstallprompt` once the
 * site is installable (manifest + icons); the event must be captured early and
 * `prompt()` deferred until the user asks, otherwise Chrome drops it.
 *
 * Returns whether an install prompt is currently available, a
 * ``promptInstall()`` that shows the native install UI, and whether the app is
 * already running standalone. Installability is inherently browser-dependent:
 * Brave/Firefox often never fire the event, and Safari/iOS never does (installs
 * happen via the Share menu), so callers must fall back to manual instructions.
 */
export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setStandalone(isStandalone());
    };
    // The display-mode media query flips when the user launches the installed
    // app, so re-check then (covers both WebAPK and iOS web clips).
    let mql: MediaQueryList | null = null;
    const onModeChange = () => setStandalone(isStandalone());
    try {
      mql = window.matchMedia("(display-mode: standalone)");
      mql.addEventListener?.("change", onModeChange);
    } catch {
      /* matchMedia unavailable */
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mql?.removeEventListener?.("change", onModeChange);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    // The prompt is one-shot; clear it so the banner does not reappear.
    setDeferredPrompt(null);
    return choice.outcome === "accepted";
  }, [deferredPrompt]);

  return { canInstall: !!deferredPrompt, promptInstall, isStandalone: standalone };
}
