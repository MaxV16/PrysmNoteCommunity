"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  DESKTOP_TITLEBAR_HEIGHT,
  getDesktopBridge,
  hasWindowControlsOverlay,
} from "@/lib/desktop-bridge";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const NON_APP_ROUTE = /^\/(marketing|login|register|forgot-password|reset-password|verify-email|mcp|privacy|tos|about|contact|changelog|downloads)/;

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize a CSS color token to #rrggbb for Electron's titleBarOverlay. */
function normalizeHex(value: string): string | undefined {
  const v = value.trim();
  if (!HEX_COLOR.test(v)) return undefined;
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

/**
 * In-app window controls for desktop builds whose window is frameless (no
 * native `titleBarOverlay`). Wired through the desktop bridge; the drag region
 * is the rest of the strip, these buttons opt out with `no-drag`.
 */
function WindowControls() {
  const bridge = getDesktopBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.isMaximized().then((m) => {
      if (alive) setMaximized(m);
    });
    bridge.onMaximizedChanged((m) => {
      if (alive) setMaximized(m);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const toggleRestore = async () => {
    bridge?.maximizeToggle();
    try {
      setMaximized(Boolean(await bridge?.isMaximized()));
    } catch {
      // The maximized-changed event keeps the icon in sync anyway.
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
        onClick={() => void toggleRestore()}
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
        className="flex w-12 items-center justify-center text-secondary transition-colors hover:bg-danger hover:text-[var(--on-gradient)]"
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M2 2l6 6M8 2L2 8" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Electron titlebar. Only renders inside the desktop shell (window.prysmDesktop
 * feature-detected) and only on the in-app routes - the marketing site and auth
 * pages keep their own full-bleed layout.
 *
 * - macOS: hiddenInset keeps native traffic lights, so this is a transparent
 *   pad that supplies the drag region only.
 * - Windows/Linux with the native titleBarOverlay: drag-only name strip; the OS
 *   draws minimize/maximize/close on the right. It is sized to
 *   `titlebar-area-*` so content never sits under those buttons.
 * - Windows/Linux without an overlay (desktop builds older than that change are
 *   frameless): draw the controls in-app, otherwise the window has none.
 */
export function DesktopTitlebar() {
  const pathname = usePathname();
  const bridge = getDesktopBridge();
  const [mounted, setMounted] = useState(false);
  const [nativeControls, setNativeControls] = useState(true);
  const [hasAppShell, setHasAppShell] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (bridge && bridge.platform !== "darwin") {
      setNativeControls(hasWindowControlsOverlay());
    }
  }, [bridge]);

  // The desktop chrome (drag strip + the `desktop-shell` layout class) may only
  // exist when the in-app shell is actually mounted. The public marketing
  // landing also lives at "/", so trusting the path alone applied the
  // fixed-height shell layout to it and left the page unable to scroll or
  // respond to clicks.
  useEffect(() => {
    const check = () =>
      setHasAppShell(Boolean(document.querySelector("[data-app-shell]")));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const show = Boolean(
    bridge && mounted && hasAppShell && !(pathname && NON_APP_ROUTE.test(pathname))
  );
  const inAppControls = Boolean(bridge && bridge.platform !== "darwin" && !nativeControls);

  // While the shell titlebar is visible, make the body a flex column so the
  // titlebar and the app share the viewport instead of the app's 100dvh
  // starting below the titlebar and overflowing by its height.
  useEffect(() => {
    if (!show) return;
    document.body.classList.add("desktop-shell");
    return () => document.body.classList.remove("desktop-shell");
  }, [show]);

  // Windows/Linux: paint the native title-bar overlay with the active theme's
  // surface/text colors, so a light theme does not show a dark strip behind the
  // OS-drawn window buttons. Re-runs whenever the theme swaps (the app sets
  // `data-theme` on <html>).
  useEffect(() => {
    if (!show || bridge?.platform === "darwin" || !bridge?.setTitleBarOverlay) return;
    const push = () => {
      const styles = getComputedStyle(document.documentElement);
      const color = normalizeHex(styles.getPropertyValue("--bg-surface"));
      const symbolColor = normalizeHex(styles.getPropertyValue("--text-primary"));
      if (!color && !symbolColor) return;
      bridge.setTitleBarOverlay?.({ color, symbolColor });
    };
    push();
    const observer = new MutationObserver(push);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, [show, bridge]);

  if (!show) return null;

  if (bridge!.platform === "darwin") {
    // Traffic-light alignment pad only; the empty space is the drag region.
    return (
      <div
        className="shrink-0"
        style={{ height: DESKTOP_TITLEBAR_HEIGHT, ...dragRegion }}
        aria-hidden
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center border-b border-border bg-surface"
      style={{
        ...dragRegion,
        height: DESKTOP_TITLEBAR_HEIGHT,
        marginLeft: "env(titlebar-area-x, 0px)",
        width: "env(titlebar-area-width, 100%)",
      }}
    >
      <span className="select-none pl-3 text-[11px] font-medium text-muted">Prysm Note</span>
      {inAppControls ? (
        <div className="ml-auto h-full">
          <WindowControls />
        </div>
      ) : null}
    </div>
  );
}
