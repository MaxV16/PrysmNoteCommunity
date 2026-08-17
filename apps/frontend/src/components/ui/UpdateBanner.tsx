"use client";

import { useAppVersion } from "@/hooks/useAppVersion";

/**
 * Shows a "new update available" pill with a Reload button when the deployed
 * backend SHA differs from the baked frontend build SHA. Mounted inside the
 * ToastProvider in the root layout; renders nothing until it detects an update.
 */
export function UpdateBanner() {
  const { outdated, reload } = useAppVersion();
  if (!outdated) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-accent/40 bg-elevated px-4 py-2.5 text-sm shadow-lg slide-up">
        <span className="text-secondary">A new update is available.</span>
        <button
          onClick={reload}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
