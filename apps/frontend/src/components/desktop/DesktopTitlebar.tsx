"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getDesktopBridge } from "@/lib/desktop-bridge";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function WindowControls() {
  const bridge = getDesktopBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    void bridge.isMaximized().then((m) => {
      if (mounted) setMaximized(m);
    });
    bridge.onMaximizedChanged((m) => {
      if (mounted) setMaximized(m);
    });
    return () => {
      mounted = false;
    };
  }, [bridge]);

  const onRestoreToggle = async () => {
    bridge?.maximizeToggle();
    try {
      const m = await bridge?.isMaximized();
      setMaximized(Boolean(m));
    } catch {
      // state syncs via the maximized-changed event anyway
    }
  };

  return (
    <div className="flex h-full items-stretch" style={noDrag}>
      <button
        onClick={bridge?.minimize}
        aria-label="Minimize"
        className="flex w-12 items-center justify-center text-secondary transition-colors hover:bg-hover"
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1 6.5h8" />
        </svg>
      </button>
      <button
        onClick={() => void onRestoreToggle()}
        aria-label={maximized ? "Restore" : "Maximize"}
        className="flex w-12 items-center justify-center text-secondary transition-colors hover:bg-hover"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M3.5 3.5v-1.8h4.8v4.8h-1.8" />
            <rect x="1.5" y="3.5" width="4.8" height="4.8" rx="0.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
          </svg>
        )}
      </button>
      <button
        onClick={bridge?.close}
        aria-label="Close"
        className="flex w-12 items-center justify-center text-secondary transition-colors hover:bg-danger hover:text-white"
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M2 2l6 6M8 2L2 8" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Electron frameless-window titlebar. Only renders inside the desktop shell
 * (window.prysmDesktop feature-detected) and only on the in-app routes - the
 * marketing site and auth pages keep their own full-bleed layout.
 *
 * - macOS: hiddenInset keeps native traffic lights, so this is a transparent
 *   pad on the left of the neutral App region; no custom buttons.
 * - Windows/Linux: frameless window with right-aligned window controls wired
 *   through the desktop bridge (drag region + no-drag buttons).
 */
export function DesktopTitlebar() {
  const pathname = usePathname();
  const bridge = getDesktopBridge();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!bridge || !mounted) return null;
  if (pathname && /^\/(marketing|login|register|forgot-password|reset-password|verify-email|mcp|privacy|tos|about|contact|changelog|downloads)/.test(pathname)) {
    return null;
  }

  if (bridge.platform === "darwin") {
    // Traffic-light alignment pad only; the empty space is the drag region.
    return <div className="h-[38px] shrink-0" style={dragRegion} aria-hidden />;
  }

  return (
    <div
      className="flex h-[38px] shrink-0 items-center border-b border-border bg-surface"
      style={dragRegion}
    >
      <span className="select-none pl-3 text-[11px] font-medium text-muted">Prysm Note</span>
      <div className="ml-auto h-full">
        <WindowControls />
      </div>
    </div>
  );
}