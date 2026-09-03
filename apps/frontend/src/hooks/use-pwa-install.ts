"use client";

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * PWA install prompt capture. Browsers fire `beforeinstallprompt` once the
 * site is installable (manifest + icons); the event must be captured early and
 * `prompt()` deferred until the user asks, otherwise Chrome drops it.
 *
 * Returns whether an install prompt is currently available and a
 * ``promptInstall()`` that shows the native install UI. Installability is
 * inherently browser-dependent: Safari/iOS never fires the event (installs are
 * done via the Share menu), so the banner simply never appears there.
 */
export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    // The prompt is one-shot; clear it so the banner does not reappear.
    setDeferredPrompt(null);
    return choice.outcome === "accepted";
  }, [deferredPrompt]);

  return { canInstall: !!deferredPrompt, promptInstall };
}
