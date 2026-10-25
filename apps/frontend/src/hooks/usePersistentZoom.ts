"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  normalizeZoomLevel,
  readStoredZoom,
  stepZoom,
  writeStoredZoom,
  type ZoomLadder,
} from "@/lib/view-zoom";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface PersistentZoom {
  zoom: number;
  setZoom: (value: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

/**
 * A per-view zoom that survives reloads.
 *
 * The stored value is read in a layout effect (before paint on the client) so a
 * returning user sees their chosen density on the first frame instead of a
 * default flash. Every write is validated and snapped to the view's ladder, so
 * corrupt or legacy storage can never collapse a column.
 */
export function usePersistentZoom(
  view: string,
  levels: ZoomLadder,
  fallback = 1
): PersistentZoom {
  const [zoom, setZoomState] = useState(() => normalizeZoomLevel(fallback, levels, fallback));

  useIsomorphicLayoutEffect(() => {
    const stored = readStoredZoom(view, levels, fallback);
    setZoomState((current) => (current === stored ? current : stored));
  }, [view, levels, fallback]);

  const setZoom = useCallback(
    (value: number) => {
      const next = normalizeZoomLevel(value, levels, fallback);
      setZoomState(next);
      writeStoredZoom(view, next);
    },
    [view, levels, fallback]
  );

  const zoomIn = useCallback(() => {
    setZoomState((current) => {
      const next = stepZoom(current, levels, 1);
      writeStoredZoom(view, next);
      return next;
    });
  }, [view, levels]);

  const zoomOut = useCallback(() => {
    setZoomState((current) => {
      const next = stepZoom(current, levels, -1);
      writeStoredZoom(view, next);
      return next;
    });
  }, [view, levels]);

  const reset = useCallback(() => {
    const next = normalizeZoomLevel(fallback, levels, fallback);
    setZoomState(next);
    writeStoredZoom(view, next);
  }, [view, levels, fallback]);

  const index = levels.indexOf(normalizeZoomLevel(zoom, levels, fallback));

  return {
    zoom,
    setZoom,
    zoomIn,
    zoomOut,
    reset,
    canZoomIn: index >= 0 && index < levels.length - 1,
    canZoomOut: index > 0,
  };
}
