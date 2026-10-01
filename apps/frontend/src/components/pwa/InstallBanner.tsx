"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { BROWSER_LABEL, detectBrowser, detectOS, installGuide, supportsNativePrompt } from "@/lib/browser";

interface InstallBannerProps {
  /** Compact copy on small screens. */
  smallScreen?: boolean;
  /**
   * Open the step-by-step guide immediately (set when the user arrived from the
   * marketing "Install on your phone" button via `?install=1`).
   */
  autoOpenGuide?: boolean;
}

/**
 * Cross-browser PWA install surface.
 *
 * - Chromium Android / desktop with a captured `beforeinstallprompt`: shows an
 *   Install button that opens the native dialog.
 * - Brave / Firefox on Android and every iOS browser: shows a "How" button that
 *   opens browser-specific manual steps (the event never fires there).
 *
 * Hidden once the app runs standalone, or after the user dismisses it.
 */
export function InstallBanner({ smallScreen = false, autoOpenGuide = false }: InstallBannerProps) {
  const { canInstall, promptInstall, isStandalone } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const autoOpened = useRef(false);

  const { os, browser, guide } = useMemo(() => {
    if (typeof navigator === "undefined") {
      return { os: "desktop" as const, browser: "other" as const, guide: installGuide("desktop", "other") };
    }
    const ua = navigator.userAgent;
    const detectedOS = detectOS(ua);
    const detectedBrowser = detectBrowser(ua);
    return { os: detectedOS, browser: detectedBrowser, guide: installGuide(detectedOS, detectedBrowser) };
  }, []);

  const isMobileOS = os === "ios" || os === "android";
  // Brave/Firefox on Android can fire `beforeinstallprompt` too, but calling
  // prompt() on it does nothing there, so only trust it where WebAPK is real.
  const nativeAvailable = canInstall && supportsNativePrompt(os, browser);

  // The explicit `?install=1` request opens the guide right away.
  useEffect(() => {
    if (autoOpenGuide && !autoOpened.current && !isStandalone) {
      autoOpened.current = true;
      setGuideOpen(true);
    }
  }, [autoOpenGuide, isStandalone]);

  if (isStandalone || dismissed) return null;
  // Show when we can offer a native install, on a phone (manual steps), or when
  // the user explicitly asked from the marketing page.
  if (!nativeAvailable && !isMobileOS && !autoOpenGuide) return null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-elevated px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-secondary">
          {nativeAvailable
            ? smallScreen
              ? "Install Prysm Note for quick access and voice capture."
              : "Install Prysm Note on this device for quick access."
            : `Add Prysm Note to your Home Screen (${BROWSER_LABEL[browser]}).`}
        </p>
        {nativeAvailable ? (
          <button
            onClick={() => {
              void promptInstall();
              setDismissed(true);
            }}
            className="btn btn-primary px-3 py-1 text-[11px]"
          >
            Install
          </button>
        ) : (
          <button onClick={() => setGuideOpen(true)} className="btn btn-primary px-3 py-1 text-[11px]">
            How
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss install prompt"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs text-muted hover:bg-hover hover:text-primary"
        >
          ✕
        </button>
      </div>

      <Modal isOpen={guideOpen} onClose={() => setGuideOpen(false)} title={guide.title}>
        <ol className="space-y-3">
          {guide.steps.map((step, i) => (
            <li key={step} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                {i + 1}
              </span>
              <span className="text-sm leading-relaxed text-secondary">{step}</span>
            </li>
          ))}
        </ol>
        {nativeAvailable && (
          <button
            onClick={() => {
              void promptInstall();
              setGuideOpen(false);
              setDismissed(true);
            }}
            className="btn-gradient mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-semibold"
          >
            Install now
          </button>
        )}
      </Modal>
    </>
  );
}
