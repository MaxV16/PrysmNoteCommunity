import { useEffect, useState } from "react";

export const DAY_WIDTH = 120;
export const DAY_HEADER_HEIGHT = 56;
export const BAR_HEIGHT = 40;
export const BAR_GAP = 8;
export const TOP_PADDING = 5;
/** Height of a collapsed swimlane row on both the label and canvas sides. */
export const SECTION_HEADER_HEIGHT = 40;

/**
 * Minimum rendered lane height. TimelineLane enforces this, so the left labels
 * column must use the same floor or empty lanes desync from their labels.
 */
export const MIN_LANE_HEIGHT = 48;

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
  const [width, setWidth] = useState(() => DAY_WIDTH * zoom);
  useEffect(() => {
    const update = () => {
      const vw = typeof window === "undefined" ? 120 : window.innerWidth;
      const base = Math.round(Math.min(DAY_WIDTH, Math.max(56, vw * 0.15)));
      setWidth(base * zoom);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [zoom]);
  return width;
}