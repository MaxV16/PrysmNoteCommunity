"use client";

import { useEffect, useRef } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Turnstile is client-only"));
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error("Turnstile script loaded without window.turnstile"));
    };
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface TurnstileWidgetProps {
  onToken: (token: string) => void;
  onExpire: () => void;
}

export function TurnstileWidget({ onToken, onExpire }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Callbacks live in a ref so a parent re-render never re-creates the widget
  // (which would invalidate a token in flight).
  const callbacksRef = useRef({ onToken, onExpire });
  callbacksRef.current = { onToken, onExpire };

  useEffect(() => {
    let cancelled = false;
    let api: TurnstileApi | null = null;
    loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        api = turnstile;
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          action: "signup",
          callback: (token: string) => callbacksRef.current.onToken(token),
          "expired-callback": () => {
            callbacksRef.current.onExpire();
            if (widgetIdRef.current) turnstile.reset(widgetIdRef.current);
          },
          "error-callback": () => callbacksRef.current.onExpire(),
        });
      })
      .catch(() => {
        // Script unavailable: leave the container empty. The submit guard on
        // the register page (and a missing token) blocks submission until the
        // widget is restored, and the backend still fails closed when the
        // secret is configured.
      });
    return () => {
      cancelled = true;
      if (api && widgetIdRef.current) {
        api.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="turnstile-widget"
      className="flex min-h-[65px] justify-center py-1"
    />
  );
}