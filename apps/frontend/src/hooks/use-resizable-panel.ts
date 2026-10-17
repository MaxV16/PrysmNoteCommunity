"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";

export type ResizablePanelSide = "left" | "right";

export const PANEL_RESIZE_MIN_VIEWPORT = 640;
const STORAGE_PREFIX = "prysm_panel_width";
const RESIZE_STEP = 16;
const CONTENT_RESERVE = 320;

export function panelResizePlatform(): string {
  const bridge = getDesktopBridge();
  if (!bridge) return "web";
  const platform = bridge.platform?.toLowerCase() ?? "";
  if (!platform) return "desktop";
  if (platform.includes("darwin") || platform.includes("mac")) return "darwin";
  if (platform.includes("win")) return "win32";
  if (platform.includes("linux")) return "linux";
  return platform;
}

export function panelStorageKey(panel: string, suffix?: string): string {
  return `${STORAGE_PREFIX}:${panelResizePlatform()}:${panel}${suffix ? `:${suffix}` : ""}`;
}

export function clampPanelWidth(
  width: number,
  minWidth: number,
  maxWidth: number,
  viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth
): number {
  const availableMax = Math.max(
    minWidth,
    Math.min(maxWidth, viewportWidth - CONTENT_RESERVE)
  );
  return Math.round(Math.min(availableMax, Math.max(minWidth, width)));
}

export function readStoredPanelWidth(
  storageKey: string,
  fallback: number,
  minWidth: number,
  maxWidth: number,
  viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return clampPanelWidth(fallback, minWidth, maxWidth, viewportWidth);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return clampPanelWidth(fallback, minWidth, maxWidth, viewportWidth);
    }
    return clampPanelWidth(parsed, minWidth, maxWidth, viewportWidth);
  } catch {
    return clampPanelWidth(fallback, minWidth, maxWidth, viewportWidth);
  }
}

interface UseResizablePanelOptions {
  panel: string;
  suffix?: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  side: ResizablePanelSide;
}

export function useResizablePanel({
  panel,
  suffix,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
}: UseResizablePanelOptions) {
  const storageKey = panelStorageKey(panel, suffix);
  const [width, setWidth] = useState(defaultWidth);
  const [isEnabled, setIsEnabled] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(defaultWidth);
  const enabledRef = useRef(false);
  const startRef = useRef({ x: 0, width: defaultWidth });

  useEffect(() => {
    const sync = () => {
      const enabled = window.innerWidth >= PANEL_RESIZE_MIN_VIEWPORT;
      enabledRef.current = enabled;
      setIsEnabled(enabled);
      if (enabled) {
        const next = readStoredPanelWidth(
          storageKey,
          defaultWidth,
          minWidth,
          maxWidth
        );
        widthRef.current = next;
        setWidth(next);
      }
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [storageKey, defaultWidth, minWidth, maxWidth]);

  const applyWidth = useCallback(
    (value: number, persist = false) => {
      const next = clampPanelWidth(value, minWidth, maxWidth);
      widthRef.current = next;
      setWidth(next);
      if (persist && enabledRef.current) {
        try {
          window.localStorage.setItem(storageKey, String(next));
        } catch {
          // Storage can be unavailable in private mode; resizing still works.
        }
      }
    },
    [storageKey, minWidth, maxWidth]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabledRef.current || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      startRef.current = { x: event.clientX, width: widthRef.current };
      setIsResizing(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    []
  );

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (event: PointerEvent) => {
      const delta =
        side === "left"
          ? event.clientX - startRef.current.x
          : startRef.current.x - event.clientX;
      applyWidth(startRef.current.width + delta);
    };
    const finish = () => {
      setIsResizing(false);
      applyWidth(widthRef.current, true);
    };

    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [isResizing, side, applyWidth]);

  const reset = useCallback(() => {
    applyWidth(defaultWidth, true);
  }, [applyWidth, defaultWidth]);

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      reset();
    },
    [reset]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const delta = side === "left" ? direction * RESIZE_STEP : -direction * RESIZE_STEP;
      applyWidth(widthRef.current + delta, true);
    },
    [applyWidth, side]
  );

  return {
    width,
    isEnabled,
    isResizing,
    reset,
    handleProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-label": "Resize panel",
      tabIndex: 0,
      onPointerDown,
      onDoubleClick,
      onKeyDown,
    },
  };
}
