"use client";

import { useCallback, useMemo, useState } from "react";
import { todayStart } from "@/lib/dates";
import {
  TIMELINE_RENDER_DAYS,
  clampSliceStart,
  dateForDayIndex,
  initialSliceStart,
} from "@/lib/timeline-window";
import { ZOOM_LEVELS, type ZoomLevel, DEFAULT_ZOOM } from "@/components/timeline/constants";

/**
 * Timeline state for a fixed, very wide day strip.
 *
 * The canvas width never changes, so the browser owns scrolling and `scrollLeft`
 * maps directly to a date. This hook only tracks which slice of day columns is
 * rendered around the viewport; moving the slice never moves the content,
 * because every day keeps its absolute pixel position in the strip.
 */
export function useTimeline() {
  const [sliceStart, setSliceStart] = useState(() => initialSliceStart());
  const [zoom, setZoom] = useState<ZoomLevel>(DEFAULT_ZOOM);
  // `today` is resolved once per mount; the label/offsets stay stable for the
  // session even if the app is left open across midnight.
  const today = useMemo(() => todayStart(), []);

  const days = useMemo(
    () =>
      Array.from({ length: TIMELINE_RENDER_DAYS }, (_, i) =>
        dateForDayIndex(sliceStart + i, today)
      ),
    [sliceStart, today]
  );

  const visibleRange = useMemo(
    () => ({
      start: days[0],
      end: dateForDayIndex(sliceStart + TIMELINE_RENDER_DAYS, today),
    }),
    [days, sliceStart, today]
  );

  const moveSlice = useCallback((start: number) => {
    setSliceStart(clampSliceStart(start));
  }, []);

  const changeZoom = useCallback((nextZoom: ZoomLevel) => {
    setZoom(nextZoom);
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((current) => {
      const idx = ZOOM_LEVELS.indexOf(current);
      if (idx < ZOOM_LEVELS.length - 1) return ZOOM_LEVELS[idx + 1];
      return current;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((current) => {
      const idx = ZOOM_LEVELS.indexOf(current);
      if (idx > 0) return ZOOM_LEVELS[idx - 1];
      return current;
    });
  }, []);

  return {
    visibleRange,
    days,
    sliceStart,
    moveSlice,
    today,
    zoom,
    setZoom: changeZoom,
    zoomIn,
    zoomOut,
    zoomLevels: ZOOM_LEVELS,
  };
}
