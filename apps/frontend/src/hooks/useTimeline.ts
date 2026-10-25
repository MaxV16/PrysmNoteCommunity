"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { todayStart } from "@/lib/dates";
import {
  TIMELINE_RENDER_DAYS,
  clampSliceStart,
  dateForDayIndex,
  initialSliceStart,
} from "@/lib/timeline-window";
import { ZOOM_LEVELS, DEFAULT_ZOOM } from "@/components/timeline/constants";
import { usePersistentZoom } from "@/hooks/usePersistentZoom";

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
  // Per-device zoom, persisted under `prysm-zoom-timeline` and read before the
  // first paint so a returning user keeps their chosen density.
  const { zoom, setZoom, zoomIn, zoomOut, reset: resetZoom } = usePersistentZoom(
    "timeline",
    ZOOM_LEVELS,
    DEFAULT_ZOOM
  );
  // `today` re-resolves on its own so a session left open across midnight keeps
  // showing the real current day instead of staying on the day the app was
  // opened until a hard refresh. It refreshes on a short interval (only while
  // the tab is alive) and immediately when the app returns to the foreground.
  const [today, setToday] = useState(() => todayStart());

  useEffect(() => {
    const resync = () =>
      setToday((prev) => {
        const next = todayStart();
        return next.getTime() === prev.getTime() ? prev : next;
      });
    const interval = setInterval(resync, 60_000);
    const onWake = () => {
      if (document.visibilityState !== "hidden") resync();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

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

  const changeZoom = useCallback(
    (nextZoom: number) => {
      setZoom(nextZoom);
    },
    [setZoom]
  );

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
    resetZoom,
    zoomLevels: ZOOM_LEVELS,
  };
}
