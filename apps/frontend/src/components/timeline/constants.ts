import { useEffect, useMemo, useState } from "react";
import { useUiScale } from "@/lib/ui-scale-context";

export const DAY_WIDTH = 120;
export const DAY_HEADER_HEIGHT = 56;
export const BAR_HEIGHT = 40;
export const BAR_GAP = 8;
export const TOP_PADDING = 5;
/**
 * Extra space below the last bar in a lane. It keeps a section's empty area a
 * comfortable double-click / drop target and, because TimelineLane's day overlay
 * spans the whole lane, lets a user create a task in a section without hitting a
 * bar. Folded into computeLaneLayout's returned height so the left labels column
 * stays aligned automatically.
 */
export const SECTION_BOTTOM_PADDING = 20;
/** Height of a collapsed swimlane row on both the label and canvas sides. */
export const SECTION_HEADER_HEIGHT = 40;

/**
 * Minimum rendered lane height. TimelineLane enforces this, so the left labels
 * column must use the same floor or empty lanes desync from their labels.
 */
export const MIN_LANE_HEIGHT = 56;

/** Discrete zoom levels for the timeline (multiplier on DAY_WIDTH). */
export const ZOOM_LEVELS = [1.0, 1.5, 2.0, 3.0] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];
export const DEFAULT_ZOOM: ZoomLevel = 1.0;

/**
 * Responsive day column width: ~5-6 days visible on phones instead of the 120px
 * desktop width (clamp(56px, 15vw, 120px)). Listening to `resize` keeps the
 * density live when a phone rotates or a desktop window resizes.
 */
export function useResponsiveDayWidth(zoom: ZoomLevel = DEFAULT_ZOOM): number {
  const { scale } = useUiScale();
  const [width, setWidth] = useState(() => DAY_WIDTH * zoom * scale);
  useEffect(() => {
    const update = () => {
      const vw = typeof window === "undefined" ? 120 : window.innerWidth;
      const base = Math.round(Math.min(DAY_WIDTH, Math.max(56, vw * 0.15)));
      setWidth(Math.round(base * zoom * scale));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [zoom, scale]);
  return width;
}

export interface TimelineMetrics {
  barHeight: number;
  barGap: number;
  topPadding: number;
}

/**
 * Row metrics scaled by the device-local interface size. The lane layout and the
 * bars must read the same numbers or rows would overlap, so both derive them
 * from here. Bars keep a sane floor (24px) so they never become untappable when
 * the interface is scaled down.
 */
export function useTimelineMetrics(): TimelineMetrics {
  const { scale } = useUiScale();
  return useMemo(
    () => ({
      barHeight: Math.max(24, Math.round(BAR_HEIGHT * scale)),
      barGap: Math.max(4, Math.round(BAR_GAP * scale)),
      topPadding: Math.max(2, Math.round(TOP_PADDING * scale)),
    }),
    [scale]
  );
}