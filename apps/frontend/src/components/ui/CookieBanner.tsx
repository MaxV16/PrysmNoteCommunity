"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const CONSENT_KEY = "prysm_cookie_consent";

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!localStorage.getItem(CONSENT_KEY)) {
        setVisible(true);
      }
    } catch {
      // localStorage unavailable: show the banner so users can still read the
      // policy; dismissing just hides it for this session.
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: 1, ts: Date.now() }));
    } catch {
      // Storage full or blocked: still hide the banner for this visit.
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] w-[360px] max-w-[calc(100%-2rem)]">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-sm shadow-lg">
        <p className="text-secondary">
          We use only essential cookies to keep you signed in and secure. We do not use
          advertising or tracking cookies.
        </p>
        <div className="flex items-center justify-between gap-3">
          <Link href="/cookie-policy" className="text-xs font-medium text-accent hover:underline">
            Cookie Policy
          </Link>
          <button
            onClick={dismiss}
            className="rounded-lg border border-border bg-elevated px-4 py-1.5 text-xs font-semibold text-primary hover:bg-hover"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
