import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useUiScale } from "@/lib/ui-scale-context";
import {
  contentZoomScale,
  getTimelineZoom,
  subscribeTimelineZoom,
} from "@/lib/view-zoom";

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
import { TIMELINE_ZOOM_LEVELS } from "@/lib/view-zoom";
export { TIMELINE_ZOOM_LEVELS as ZOOM_LEVELS } from "@/lib/view-zoom";
export type ZoomLevel = (typeof TIMELINE_ZOOM_LEVELS)[number];
export const DEFAULT_ZOOM: ZoomLevel = 1.0;
/** A rendered day column never goes below this, even at the smallest zoom. */
export const MIN_RENDERED_DAY_WIDTH = 28;

/**
 * Responsive day column width. Phones get a wider column than the old
 * ~56px clamp (which clipped every task title to three characters): about
 * 4-5 days visible, 88px minimum, so a bar has room for a readable label.
 * Desktop keeps the full 120px column, which the timeline geometry and the
 * timeline smoke test both rely on. Listening to `resize` keeps the density
 * live when a phone rotates or a desktop window resizes.
 */
export const PHONE_DAY_WIDTH_MIN = 88;
export const PHONE_BREAKPOINT = 768;

export function responsiveDayWidth(viewportWidth: number): number {
  if (viewportWidth >= PHONE_BREAKPOINT) return DAY_WIDTH;
  return Math.round(Math.min(DAY_WIDTH, Math.max(PHONE_DAY_WIDTH_MIN, viewportWidth * 0.22)));
}

// `zoom` is a plain multiplier at runtime: `usePersistentZoom` always returns a
// value already snapped to the ladder, so a caller can pass the raw number.
export function useResponsiveDayWidth(zoom: number = DEFAULT_ZOOM): number {
  const { scale } = useUiScale();
  const [width, setWidth] = useState(() => Math.max(MIN_RENDERED_DAY_WIDTH, DAY_WIDTH * zoom * scale));
  useEffect(() => {
    const update = () => {
      const vw = typeof window === "undefined" ? DAY_WIDTH : window.innerWidth;
      // The phone clamp sets the BASE column, then the user's zoom multiplies it,
      // so zooming out goes below the phone default and zooming in goes above.
      setWidth(
        Math.max(MIN_RENDERED_DAY_WIDTH, Math.round(responsiveDayWidth(vw) * zoom * scale))
      );
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
  /**
   * Task label font size in px. Zooming the timeline column without zooming the
   * label is the "the UI scales but the tasks do not" bug, so the label reads
   * the same metrics as the bar it sits in.
   */
  labelPx: number;
}

/**
 * Row metrics scaled by the device-local interface size. The lane layout and the
 * bars must read the same numbers or rows would overlap, so both derive them
 * from here. Bars keep a sane floor (24px) so they never become untappable when
 * the interface is scaled down.
 */
export function useTimelineMetrics(): TimelineMetrics {
  const { scale } = useUiScale();
  const zoom = useSyncExternalStore(subscribeTimelineZoom, getTimelineZoom, () => 1);
  // View zoom and the UI scale both grow the content. Damping the zoom keeps a
  // 200% column from turning every title into one enormous word.
  const z = contentZoomScale(zoom);
  return useMemo(() => {
    const barHeight = Math.max(24, Math.round(BAR_HEIGHT * scale * z));
    return {
      barHeight,
      barGap: Math.max(4, Math.round(BAR_GAP * scale * z)),
      topPadding: Math.max(2, Math.round(TOP_PADDING * scale * z)),
      // The label is a fraction of the bar it sits in, not a fixed size. A 48px
      // bar holding 11px text is what made a zoomed timeline feel like the
      // tasks never scaled, even after the bars themselves grew.
      labelPx: Math.max(10, Math.min(22, Math.round(barHeight * 0.34))),
    };
  }, [scale, z]);
}