"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Task } from "@/types/task";
import {
  computeDragDays,
  dragOffsetPx,
  resizePreviewRange,
  type BarDragMode,
} from "@/lib/timeline-drag";

export interface TimelineBarCommit {
  task: Task;
  mode: BarDragMode;
  days: number;
  /**
   * Present only when the drop changes the task's section: a section id, or
   * null for the implicit Unsorted area. Omitted means "section unchanged".
   */
  sectionId?: string | null;
}

/**
 * A short continuity glide played once React has re-rendered the bar at its
 * committed slot: the inline preview styles are eased to their final values so
 * the drop lands instead of snapping. The move/resize-left transform subtracts
 * the snapped distance so the bar's screen position is unbroken at the instant
 * React moves `left` under it.
 */
interface Glide {
  startTransform: string | null;
  endTransform: string | null;
  startWidth: string | null;
  endWidth: string | null;
}

export interface TimelineDragContextValue {
  dayWidth: number;
  /** Ids of the sections this timeline shows (lanes), used to decide whether a
   * drop on the ungrouped lane should clear the task's section. */
  sectionIds: ReadonlySet<string>;
  onCommit: (commit: TimelineBarCommit) => void;
}

/**
 * Shared by every timeline bar and resize handle. TimelineView provides the
 * day width and the commit callback; the rest (pointer math, preview, edge
 * auto-scroll) lives in this hook.
 */
export const TimelineDragContext = createContext<TimelineDragContextValue | null>(null);

// Mouse and pen pick the task up on the first pixel. A touch waits for one
// deliberate hold. That hold is the ONLY touch contract and it is identical at
// every viewport width, so a phone and a tablet behave the same way; gating it
// on a width breakpoint is what previously made the gesture order-dependent.
const POINTER_ACTIVATION_DISTANCE = 1;
// The single hold duration that picks a touch task up. One timer means the same
// press can never mean two different things.
const LONG_PRESS_MS = 400;
// The single movement tolerance, used for BOTH decisions: a touch that travels
// further than this before the hold fires is a one-finger pan (and cancels the
// hold), and after the hold a move past it is a real drag (so the release does
// not also open the action bar). One shared value means the two rules can never
// disagree about a borderline gesture.
const MOVE_TOLERANCE_PX = 10;
// The lane/section hit-test walks `elementsFromPoint`, so on a large board it is
// throttled instead of running every frame; a drop still hit-tests exactly.
const HIT_TEST_INTERVAL_MS = 50;
const MIN_EDGE_ZONE = 64;
const MAX_EDGE_ZONE = 180;
const EDGE_MAX_DAYS_PER_FRAME = 0.45;
const EDGE_MAX_PX_PER_FRAME = 18;
// Edge auto-scroll only kicks in when the pointer is held nearly still inside
// an edge band for EDGE_DWELL_MS. A task that lives near an edge (the first row,
// today's column) must be draggable without the canvas sliding out from under
// it, which on touch read as "the task moved a bit then the timeline moved".
const EDGE_DWELL_MS = 250;
const EDGE_STILL_PX = 6;
const HIGHLIGHT_CLASSES = ["bg-accent/15", "ring-1", "ring-inset", "ring-accent/50"];
const LANE_HIGHLIGHT_CLASSES = ["bg-accent/5", "ring-2", "ring-inset", "ring-accent/40"];
// A drag still ends with a browser `click` on the bar. The suppressor eats that
// one click (so a drop never opens the task details) and bounds itself so it can
// never swallow the user's next, unrelated tap.
const CLICK_SUPPRESS_MS = 350;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface DragSession {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  startedAt: number;
  /** True once the single touch hold timer has elapsed. */
  holdFired: boolean;
  /** Where the hold fired. Movement is measured from here, so finger wobble
   * before (or during) the hold cannot count as a deliberate drag. */
  holdX: number;
  holdY: number;
  /** True once the pointer travels past MOVE_TOLERANCE_PX after the hold, for a
   * drag pickup and for a drag-disabled bar alike. */
  movedAfterHold: boolean;
  /** True when the drag is disabled (e.g. a done task): the bar still gets the
   * touch hold, but it can never be picked up, dragged, or committed. */
  moveDisabled: boolean;
  startScrollLeft: number;
  scrollDelta: number;
  startScrollTop: number;
  scrollTopDelta: number;
  body: HTMLElement | null;
  bodyLeft: number;
  bodyTop: number;
  bodyClientWidth: number;
  bodyClientHeight: number;
  /** True when the canvas can actually scroll vertically; the vertical edge
   * auto-scroll is skipped otherwise so it cannot fight a horizontal drag. */
  bodyHasVerticalOverflow: boolean;
  /** Set once the vertical-overflow flag has been measured for this gesture. */
  overflowMeasured: boolean;
  dayWidth: number;
  el: HTMLElement;
  /** The element the pointer is captured on (the handle for a resize, the bar
   * for a move). `el` is the bar that the preview styles are written to. */
  captureEl: HTMLElement;
  task: Task;
  mode: BarDragMode;
  sectionIds: ReadonlySet<string>;
  startWidthPx: number;
  offsetPx: number;
  offsetYPx: number;
  /** undefined = pointer is not over any lane or section label. */
  dropSectionId: string | null | undefined;
  hoverEl: HTMLElement | null;
  hoverLaneEl: HTMLElement | null;
  raf: number;
  active: boolean;
  /** Touch only: pending hold-to-pickup timer; 0 once fired/cancelled. */
  holdTimer: number;
  /** Touch only: the hold was cancelled by movement and the gesture pans the canvas. */
  panning: boolean;
  /** Touch only: on a phone-sized viewport a touch must be held before it picks
   * the bar up (so a one-finger drag pans instead). On a wide viewport, where a
   * finger is unambiguous, touch picks the bar up immediately like a mouse so
   * there is no hold delay on a Windows touchscreen. */
  holdToDrag: boolean;
  /** True once the pointer has moved past ~2px, used to suppress the trailing click. */
  hasMoved: boolean;
  lastTransform: string;
  lastWidth: string;
  lastHitX: number;
  lastHitY: number;
  lastHitTestAt: number;
  /** Last pointer sample used to tell a still hold from an active drag. */
  edgeRefX: number;
  edgeRefY: number;
  edgeRefAt: number;
}

function clearHighlight(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove(...HIGHLIGHT_CLASSES, ...LANE_HIGHLIGHT_CLASSES);
}

/**
 * One-shot compositor-only pulse when a dragged bar lands in its new slot. Runs
 * imperatively on the element (no React render), so a drop stays cheap; the
 * class is removed on a timer so it can replay on the next drop and never keeps
 * an animation alive.
 */
function settleBar(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("animate-bar-settle");
  // Force a style flush so re-adding the class restarts a just-finished pulse.
  void el.offsetWidth;
  el.classList.add("animate-bar-settle");
  window.setTimeout(() => el.classList.remove("animate-bar-settle"), 320);
}

/**
 * Whether the drop should change the task's section.
 *
 * A lane drop targets that lane's section; the ungrouped lane clears the pin,
 * but only when the task is currently in a section this timeline shows, so a
 * task pinned to a board/kanban section is left untouched by a timeline drag.
 */
function resolveSectionChange(s: DragSession): boolean {
  const drop = s.dropSectionId;
  if (drop === undefined) return false;
  if (drop === null) {
    return s.task.board_section_id != null && s.sectionIds.has(s.task.board_section_id);
  }
  return drop !== s.task.board_section_id;
}

/**
 * Pointer engine for a timeline bar (move) or one of its resize handles.
 *
 * - Activation is one contract per input class, and nothing depends on the
 *   viewport width:
 *   - mouse/pen: picked up on the first pixel of movement;
 *   - touch: picked up only after the single LONG_PRESS_MS hold. Movement past
 *     the single MOVE_TOLERANCE_PX before that hold fires is a one-finger
 *     timeline pan and cancels the hold for good, so a press can never mean two
 *     things and no timer can fire late and flip the gesture. The same contract
 *     applies on a phone and a tablet.
 *   - A drag-disabled bar (a done task) still gets the hold so a stationary
 *     release opens the mobile action bar, but it is never picked up.
 *   `touch-action: none` on the bar keeps the browser from stealing the
 *   gesture, so the hold-cancel fallback pans the canvas itself.
 * - A move drag tracks the pointer on BOTH axes (continuous pixels, no day
 *   snapping), so the bar stays under the cursor the way a native drag does.
 *   The drop is quantized to whole days, and the lane under the pointer picks
 *   the destination section.
 * - One RAF loop owns every write. It avoids layout reads entirely (the canvas
 *   scroll deltas arrive through a passive `scroll` listener) and only touches
 *   the DOM when a value actually changed, so a high-polling-rate mouse cannot
 *   thrash it. Press time performs a single body geometry read.
 * - The lane/section hit-test (`elementsFromPoint`) runs at most every
 *   HIT_TEST_INTERVAL_MS while the pointer moves (and exactly once on release),
 *   so a large board cannot force a hit-test on every frame.
 */
export function useTimelineBarDrag(
  task: Task,
  mode: BarDragMode,
  disabled?: boolean,
  options?: { onLongPress?: () => void }
) {
  const ctx = useContext(TimelineDragContext);
  const ref = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const [dragging, setDragging] = useState(false);
  // Live start/end dates shown above the bar while a resize handle is dragged.
  const [resizePreview, setResizePreview] = useState<{ start: string; due: string } | null>(null);
  const previewSigRef = useRef<string>("");
  // Set on a committed drop and consumed by the layout effect after React has
  // re-rendered the bar at its new slot (see `Glide`).
  const glideRef = useRef<Glide | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const taskRef = useRef(task);
  taskRef.current = task;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const tickRef = useRef<() => void>(() => {});

  // Only the properties a preview actually wrote may be reset; clearing
  // `width` on a move would wipe the React-set percent width.
  const previewTransformRef = useRef(false);
  const previewWidthRef = useRef(false);

  const resetPreview = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    if (previewTransformRef.current) {
      el.style.transform = "";
      previewTransformRef.current = false;
    }
    if (previewWidthRef.current) {
      el.style.width = "";
      previewWidthRef.current = false;
    }
  }, []);

  const applyPreview = useCallback((s: DragSession) => {
    const offset = s.offsetPx;
    if (s.mode === "move") {
      // Both axes so the bar follows the cursor; the lane it is over sets the
      // section, and the x offset sets the days. A tiny compositor-only scale
      // lifts the bar under the finger/cursor, so the grab reads as tactile
      // without touching layout.
      const transform = `translate3d(${offset}px, ${s.offsetYPx}px, 0) scale(1.03)`;
      if (transform !== s.lastTransform) {
        s.el.style.transform = transform;
        s.lastTransform = transform;
        previewTransformRef.current = true;
      }
      return;
    }
    if (s.mode === "resize-right") {
      const width = `${Math.max(s.dayWidth, 8, s.startWidthPx + offset)}px`;
      if (width !== s.lastWidth) {
        s.el.style.width = width;
        s.lastWidth = width;
        previewWidthRef.current = true;
      }
      return;
    }
    // resize-left moves the left edge and keeps the right edge anchored, so the
    // bar extends left instead of growing off its fixed `left`.
    const transform = `translate3d(${offset}px, 0, 0)`;
    if (transform !== s.lastTransform) {
      s.el.style.transform = transform;
      s.lastTransform = transform;
      previewTransformRef.current = true;
    }
    const width = `${Math.max(s.dayWidth, 8, s.startWidthPx - offset)}px`;
    if (width !== s.lastWidth) {
      s.el.style.width = width;
      s.lastWidth = width;
      previewWidthRef.current = true;
    }
  }, []);

  // While a resize handle is being dragged, publish the dates the drop would
  // commit so the bar can show a live badge. Only touched when the whole-day
  // result actually changes, so a high-rate pointer cannot thrash React.
  const updateResizePreview = useCallback((s: DragSession) => {
    if (s.mode === "move") {
      if (previewSigRef.current !== "") {
        previewSigRef.current = "";
        setResizePreview(null);
      }
      return;
    }
    const days = s.dayWidth > 0 ? Math.round(s.offsetPx / s.dayWidth) : 0;
    const range = resizePreviewRange(s.task, days, s.mode === "resize-left" ? "left" : "right");
    const sig = range ? `${range.start}|${range.due}` : "";
    if (sig === previewSigRef.current) return;
    previewSigRef.current = sig;
    setResizePreview(range);
  }, []);

  const updateSectionTarget = useCallback((s: DragSession) => {
    // Prefer the lane under the pointer (vertical dragging between lanes), then
    // fall back to a section header in the left labels column. The dragged bar
    // follows the pointer, so skip it (and its handles) or it would always
    // resolve to the lane it started in.
    let nextSection: string | null | undefined;
    let labelEl: HTMLElement | null = null;
    let laneEl: HTMLElement | null = null;
    if (typeof document.elementsFromPoint === "function") {
      for (const el of document.elementsFromPoint(s.latestX, s.latestY)) {
        const node = el as HTMLElement;
        if (node === s.el || s.el.contains(node)) continue;
        const lane = node.closest?.("[data-timeline-lane]") as HTMLElement | null;
        if (lane) {
          const raw = lane.getAttribute("data-lane-section-id") ?? "";
          nextSection = raw === "" ? null : raw;
          laneEl = lane;
          break;
        }
        const label = node.closest?.("[data-section-drop-target]") as HTMLElement | null;
        if (label) {
          nextSection = label.getAttribute("data-section-drop-target") || null;
          labelEl = label;
          break;
        }
      }
    }
    if (labelEl !== s.hoverEl) {
      if (s.hoverEl) s.hoverEl.classList.remove(...HIGHLIGHT_CLASSES);
      if (labelEl) labelEl.classList.add(...HIGHLIGHT_CLASSES);
      s.hoverEl = labelEl;
    }
    if (laneEl !== s.hoverLaneEl) {
      if (s.hoverLaneEl) s.hoverLaneEl.classList.remove(...LANE_HIGHLIGHT_CLASSES);
      if (laneEl) laneEl.classList.add(...LANE_HIGHLIGHT_CLASSES);
      s.hoverLaneEl = laneEl;
    }
    s.dropSectionId = nextSection;
  }, []);

  const renderFrame = useCallback(
    (s: DragSession) => {
      // Eased edge auto-scroll, active only during this gesture. The viewport
      // size is captured at drag start, so this never forces a layout read.
      // Scrolling waits until the pointer has been held nearly still at an edge:
      // an in-progress drag must move the task, never slide the canvas.
      const still =
        Math.hypot(s.latestX - s.edgeRefX, s.latestY - s.edgeRefY) <= EDGE_STILL_PX;
      if (!still) {
        s.edgeRefX = s.latestX;
        s.edgeRefY = s.latestY;
        s.edgeRefAt = now();
      }
      const dwelled = now() - s.edgeRefAt >= EDGE_DWELL_MS;
      const width = s.bodyClientWidth;
      const edgeZoneX = Math.min(MAX_EDGE_ZONE, Math.max(MIN_EDGE_ZONE, width * 0.2));
      const xInBody = s.latestX - s.bodyLeft;
      let velocityX = 0;
      if (dwelled && xInBody < edgeZoneX) {
        const intensity = Math.min(1, Math.max(0, (edgeZoneX - xInBody) / edgeZoneX));
        velocityX = -intensity * intensity * s.dayWidth * EDGE_MAX_DAYS_PER_FRAME;
      } else if (dwelled && xInBody > width - edgeZoneX) {
        const intensity = Math.min(1, Math.max(0, (xInBody - (width - edgeZoneX)) / edgeZoneX));
        velocityX = intensity * intensity * s.dayWidth * EDGE_MAX_DAYS_PER_FRAME;
      }
      if (velocityX !== 0 && s.body) s.body.scrollLeft += velocityX;

      // Vertical edge auto-scroll so a lane off-screen can be reached, but only
      // when the canvas can actually scroll vertically: a horizontal drag near
      // the bottom of a non-overflowing canvas must never nudge lanes. The band
      // is narrower than the horizontal one so it cannot hijack a mid-canvas
      // horizontal drag.
      const height = s.bodyClientHeight;
      if (height > 0 && s.bodyHasVerticalOverflow) {
        const edgeZoneY = Math.min(120, Math.max(48, height * 0.12));
        const yInBody = s.latestY - s.bodyTop;
        let velocityY = 0;
        if (dwelled && yInBody < edgeZoneY) {
          const intensity = Math.min(1, Math.max(0, (edgeZoneY - yInBody) / edgeZoneY));
          velocityY = -intensity * intensity * EDGE_MAX_PX_PER_FRAME;
        } else if (dwelled && yInBody > height - edgeZoneY) {
          const intensity = Math.min(1, Math.max(0, (yInBody - (height - edgeZoneY)) / edgeZoneY));
          velocityY = intensity * intensity * EDGE_MAX_PX_PER_FRAME;
        }
        if (velocityY !== 0 && s.body) s.body.scrollTop += velocityY;
      }

      const offsetX = dragOffsetPx({
        dx: s.latestX - s.startX,
        scrollDelta: s.scrollDelta,
      });
      const offsetY = dragOffsetPx({
        dx: s.latestY - s.startY,
        scrollDelta: s.scrollTopDelta,
      });
      if (offsetX !== s.offsetPx || offsetY !== s.offsetYPx) {
        s.offsetPx = offsetX;
        s.offsetYPx = offsetY;
        applyPreview(s);
        updateResizePreview(s);
      }

      if (
        (s.latestX !== s.lastHitX || s.latestY !== s.lastHitY) &&
        now() - s.lastHitTestAt >= HIT_TEST_INTERVAL_MS
      ) {
        s.lastHitX = s.latestX;
        s.lastHitY = s.latestY;
        s.lastHitTestAt = now();
        updateSectionTarget(s);
      }
    },
    [applyPreview, updateSectionTarget, updateResizePreview]
  );

  const tick = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.active) return;
    s.raf = 0;
    renderFrame(s);
    if (sessionRef.current === s && s.active) {
      s.raf = requestAnimationFrame(tickRef.current);
    }
  }, [renderFrame]);
  tickRef.current = tick;

  // A touch drag must survive the browser's scroll gesture: while the bar is
  // active, cancelling the default touchmove stops Chromium from taking the
  // pointer over as a pan and firing pointercancel mid-drag (which would abort
  // the drop and leave the task in place). It is only attached once a drag is
  // active, so a quick touch drag still pans the timeline as intended.
  const preventTouchMove = useCallback((e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  }, []);

  const activate = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.active || s.moveDisabled) return;
    s.active = true;
    // Measure the two drag-loop inputs once, here, instead of at press: a
    // disabled bar never reaches this, and a move drag never needs the bar
    // width, so the press path stays free of repeated layout reads.
    if (!s.overflowMeasured) {
      s.overflowMeasured = true;
      s.bodyHasVerticalOverflow = s.body
        ? s.body.scrollHeight > s.body.clientHeight + 1
        : false;
    }
    if (s.mode !== "move" && s.startWidthPx === 0) {
      s.startWidthPx = s.el.getBoundingClientRect().width;
    }
    // A leftover glide transition from the previous drop would make this drag
    // lag behind the pointer, so clear it before writing the first preview.
    s.el.style.transition = "";
    s.el.style.willChange = "transform";
    s.el.style.zIndex = "100";
    s.el.style.touchAction = "none";
    s.el.style.cursor = "grabbing";
    if (s.body) s.body.style.userSelect = "none";
    if (s.holdToDrag) {
      window.addEventListener("touchmove", preventTouchMove, { passive: false });
    }
    setDragging(true);
    // Paint the first frame synchronously so activation has zero latency.
    renderFrame(s);
    if (s.raf === 0) s.raf = requestAnimationFrame(tickRef.current);
  }, [renderFrame, preventTouchMove]);

  const activateRef = useRef(activate);
  activateRef.current = activate;
  const finishRef = useRef<(commit: boolean) => void>(() => {});

  // Capture-phase click suppressor. See CLICK_SUPPRESS_MS above.
  const suppressClickRef = useRef<{ handler: (e: Event) => void; timer: number } | null>(null);

  const disarmClickSuppressor = useCallback(() => {
    const suppressor = suppressClickRef.current;
    if (!suppressor) return;
    window.removeEventListener("click", suppressor.handler, true);
    window.clearTimeout(suppressor.timer);
    suppressClickRef.current = null;
  }, []);

  const armClickSuppressor = useCallback(() => {
    disarmClickSuppressor();
    const handler = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      disarmClickSuppressor();
    };
    const timer = window.setTimeout(disarmClickSuppressor, CLICK_SUPPRESS_MS);
    suppressClickRef.current = { handler, timer };
    window.addEventListener("click", handler, true);
  }, [disarmClickSuppressor]);

  // The canvas scroll deltas are tracked through a passive listener instead of
  // per-frame `scrollLeft`/`scrollTop` reads, which would force layout.
  const onBodyScroll = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.body) return;
    s.scrollDelta = s.body.scrollLeft - s.startScrollLeft;
    s.scrollTopDelta = s.body.scrollTop - s.startScrollTop;
  }, []);

  const onWindowMove = useCallback((e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    s.latestX = e.clientX;
    s.latestY = e.clientY;
    if (Math.hypot(dx, dy) > 2) s.hasMoved = true;

    // One rule decides whether the release was a drag or a stationary hold, for
    // a drag pickup and a drag-disabled bar alike: travel past the single
    // tolerance measured from where the hold fired means a real move.
    if (s.holdFired && !s.movedAfterHold) {
      if (Math.hypot(e.clientX - s.holdX, e.clientY - s.holdY) >= MOVE_TOLERANCE_PX) {
        s.movedAfterHold = true;
      }
    }

    if (!s.active) {
      if (s.holdToDrag) {
        if (s.moveDisabled) {
          // A drag-disabled bar is never picked up. Movement past the single
          // tolerance cancels the pending hold, so a swipe across a done task
          // cannot open its menu after the fact. There is no drag, and the bar
          // itself never pans the canvas.
          if (!s.holdFired && s.holdTimer !== 0 && Math.hypot(dx, dy) >= MOVE_TOLERANCE_PX) {
            window.clearTimeout(s.holdTimer);
            s.holdTimer = 0;
          }
          return;
        }
        if (s.panning) {
          if (s.body) {
            s.body.scrollLeft = s.startScrollLeft - dx;
            s.body.scrollTop = s.startScrollTop - dy;
          }
          return;
        }
        if (Math.hypot(dx, dy) < MOVE_TOLERANCE_PX) return;
        // Movement past the tolerance before the hold fires is a one-finger
        // timeline pan. The hold is cancelled for good, so the same press can
        // never also pick the task up: no timer can fire late and flip the
        // meaning of the gesture, which is exactly what made the old behaviour
        // order-dependent. There is no time window to race against.
        if (s.holdTimer !== 0) {
          window.clearTimeout(s.holdTimer);
          s.holdTimer = 0;
        }
        s.panning = true;
        return;
      }
      if (Math.hypot(dx, dy) >= POINTER_ACTIVATION_DISTANCE) activateRef.current();
      return;
    }
    if (s.raf === 0) s.raf = requestAnimationFrame(tickRef.current);
  }, []);

  const onWindowUp = useCallback((e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    // Settle the final pointer position and drop target before committing, so
    // the last few pixels of the gesture are not lost to the frame budget.
    s.latestX = e.clientX;
    s.latestY = e.clientY;
    if (s.active) updateSectionTarget(s);
    finishRef.current(true);
  }, [updateSectionTarget]);

  const onWindowCancel = useCallback((e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    finishRef.current(false);
  }, []);

  // Capture is implicitly released right after pointerup/pointercancel are
  // dispatched, so this always fires even when a terminal event is dropped.
  // It is the safety net that guarantees no gesture can strand a session.
  const onLostCapture = useCallback((e: Event) => {
    const s = sessionRef.current;
    if (!s) return;
    const pointerId = (e as PointerEvent).pointerId;
    if (typeof pointerId === "number" && pointerId !== s.pointerId) return;
    finishRef.current(false);
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const s = sessionRef.current;
      if (!s) return;
      sessionRef.current = null;
      if (s.raf) cancelAnimationFrame(s.raf);
      if (s.holdTimer !== 0) {
        window.clearTimeout(s.holdTimer);
        s.holdTimer = 0;
      }
      clearHighlight(s.hoverEl);
      clearHighlight(s.hoverLaneEl);
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowCancel);
      s.captureEl.removeEventListener("lostpointercapture", onLostCapture);
      s.body?.removeEventListener("scroll", onBodyScroll);
      window.removeEventListener("touchmove", preventTouchMove);
      try {
        s.captureEl.releasePointerCapture(s.pointerId);
      } catch {
        // Capture may already be gone (browser-initiated release).
      }
      s.el.style.willChange = "";
      s.el.style.zIndex = "";
      s.el.style.touchAction = "";
      s.el.style.cursor = "";
      if (s.body) s.body.style.userSelect = "";

      if (commit && s.active) {
        const days = computeDragDays({
          dx: s.latestX - s.startX,
          scrollDelta: s.scrollDelta,
          dayWidth: s.dayWidth,
        });
        const sectionChanged = resolveSectionChange(s);
        let committed = false;
        // The days the drop actually commits (a stationary touch hold bumps by
        // one), so the glide eases to the exact slot React will render.
        let commitDaysUsed = days;
        if (sectionChanged) {
          ctxRef.current?.onCommit({
            task: s.task,
            mode: s.mode,
            days,
            sectionId: s.dropSectionId ?? null,
          });
          committed = true;
        } else if (days !== 0 || (s.holdToDrag && s.movedAfterHold)) {
          const commitDays = days !== 0 ? days : (s.latestX >= s.startX ? 1 : -1);
          commitDaysUsed = commitDays;
          ctxRef.current?.onCommit({
            task: s.task,
            mode: s.mode,
            days: commitDays,
            sectionId: undefined,
          });
          committed = true;
        }
        // Hand the preview's final position to the layout effect as a short
        // glide to the committed slot, so the bar lands instead of snapping.
        // Only the properties the preview actually wrote are animated.
        if (committed) {
          const hasTransform = previewTransformRef.current;
          const hasWidth = previewWidthRef.current;
          if (hasTransform || hasWidth) {
            const snappedPx = commitDaysUsed * s.dayWidth;
            glideRef.current = {
              startTransform: hasTransform
                ? `translate3d(${s.offsetPx - snappedPx}px, ${s.mode === "move" ? s.offsetYPx : 0}px, 0)`
                : "",
              endTransform: hasTransform ? "translate3d(0, 0, 0)" : "",
              startWidth: hasWidth
                ? `${s.mode === "resize-left" ? s.startWidthPx - s.offsetPx : s.startWidthPx + s.offsetPx}px`
                : "",
              endWidth: hasWidth
                ? `${s.mode === "resize-left" ? s.startWidthPx - snappedPx : s.startWidthPx + snappedPx}px`
                : "",
            };
          }
        }
        previewSigRef.current = "";
        setResizePreview(null);
        // With a glide running, its transform owns the settle; otherwise fall
        // back to the compositor-only scale pulse.
        if (committed && !glideRef.current) settleBar(s.el);
        if (committed || s.hasMoved) armClickSuppressor();
      } else {
        previewSigRef.current = "";
        setResizePreview(null);
        resetPreview(s.el);
        // A touch gesture that fell through to a canvas pan started on the bar,
        // so swallow the trailing click that would otherwise open its details.
        if (s.panning && s.hasMoved) armClickSuppressor();
      }
      // A deliberate stationary touch hold opens the mobile action bar on
      // release, whether the bar is draggable or not. One condition governs it:
      // the hold fired, the gesture never panned, and the finger did not travel
      // past the single tolerance afterwards. A move therefore never also
      // prompts delete/move. The click is suppressed so the release does not
      // also open the task details.
      if (commit && s.holdToDrag && s.holdFired && !s.panning && !s.movedAfterHold) {
        armClickSuppressor();
        optionsRef.current?.onLongPress?.();
      }
      setDragging(false);
    },
      [onWindowMove, onWindowUp, onWindowCancel, onLostCapture, onBodyScroll, preventTouchMove, resetPreview, armClickSuppressor]
  );
  finishRef.current = finish;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // A terminal pointerup/pointercancel can be dropped by the browser,
      // notably for touch on Android, which would strand a session and make
      // every later press silently inert. Recover here so a fresh gesture
      // always starts from a clean slate instead of being ignored.
      if (sessionRef.current) finishRef.current(false);
      const currentCtx = ctxRef.current;
      if (!currentCtx) return;
      const el = ref.current;
      if (!el) return;
      const isTouch = (e.pointerType || "mouse") === "touch";
      // A drag-disabled bar (a done task) still owns the touch hold, so a
      // stationary press opens the mobile action bar; mouse/pen on it stay
      // inert. Everything else follows the single contract below.
      if (disabled && !isTouch) return;
      // A stale suppressor from a previous drag must never eat this press.
      disarmClickSuppressor();
      // Own the gesture: never let the canvas pan start from a bar/handle.
      e.stopPropagation();

      const body = el.closest("[data-timeline-body]") as HTMLElement | null;
      // One geometry read for the whole session: the edge zones and the pan
      // compensation derive from this single rect (plus cheap scroll reads), so
      // press time does not walk layout repeatedly.
      const rect = body?.getBoundingClientRect();
      const mode = modeRef.current;
      // Pointer capture stays on the pressed element (the resize handle), but a
      // resize preview must write to the BAR, so resolve it separately. A move
      // drag's ref already is the bar.
      const captureEl = el;
      const barEl =
        mode === "move"
          ? el
          : ((el.closest("[data-task-bar]") as HTMLElement | null) ?? el);
      const s: DragSession = {
        pointerId: e.pointerId,
        pointerType: e.pointerType || "mouse",
        startX: e.clientX,
        startY: e.clientY,
        latestX: e.clientX,
        latestY: e.clientY,
        startedAt: now(),
        holdFired: false,
        holdX: e.clientX,
        holdY: e.clientY,
        movedAfterHold: false,
        moveDisabled: !!disabled,
        startScrollLeft: body?.scrollLeft ?? 0,
        scrollDelta: 0,
        startScrollTop: body?.scrollTop ?? 0,
        scrollTopDelta: 0,
        body,
        bodyLeft: rect?.left ?? 0,
        bodyTop: rect?.top ?? 0,
        bodyClientWidth: body?.clientWidth ?? 0,
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyHasVerticalOverflow: false,
        overflowMeasured: false,
        dayWidth: currentCtx.dayWidth,
        el: barEl,
        captureEl,
        task: taskRef.current,
        mode,
        sectionIds: currentCtx.sectionIds,
        // Measured once at activation, and only for a resize gesture; a move
        // drag never needs the bar width.
        startWidthPx: 0,
        offsetPx: 0,
        offsetYPx: 0,
        dropSectionId: undefined,
        hoverEl: null,
        hoverLaneEl: null,
        raf: 0,
        active: false,
        holdTimer: 0,
        panning: false,
        holdToDrag: isTouch,
        hasMoved: false,
        lastTransform: "",
        lastWidth: "",
        lastHitX: e.clientX,
        lastHitY: e.clientY,
        lastHitTestAt: 0,
        edgeRefX: e.clientX,
        edgeRefY: e.clientY,
        edgeRefAt: now(),
      };
      sessionRef.current = s;

      // One hold timer, one duration, every touch viewport: hold the bar and it
      // is picked up, or (when the drag is disabled) it offers its action bar on
      // release. Nothing here depends on the window width, so the same press
      // means the same thing on a phone and a tablet.
      if (s.holdToDrag) {
        s.holdTimer = window.setTimeout(() => {
          s.holdTimer = 0;
          if (sessionRef.current !== s || s.panning) return;
          s.holdFired = true;
          s.holdX = s.latestX;
          s.holdY = s.latestY;
          // A drag-disabled bar stops here: it offers its action bar on a
          // stationary release but is never picked up.
          if (!s.moveDisabled) activateRef.current();
        }, LONG_PRESS_MS);
      }

      // Capture so the gesture keeps streaming to us even if the pointer leaves
      // the bar (or the window) mid-drag.
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        // Older engines without pointer capture still get the window listeners.
      }

      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      window.addEventListener("pointercancel", onWindowCancel);
      captureEl.addEventListener("lostpointercapture", onLostCapture);
      body?.addEventListener("scroll", onBodyScroll);
    },
    [disabled, onWindowMove, onWindowUp, onWindowCancel, onLostCapture, onBodyScroll, disarmClickSuppressor]
  );

  // Escape cancels and reverts an in-flight drag.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finishRef.current(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  // Drop the imperative preview once React has committed the new dates (and on
  // cancellation), so the bar never carries a stale transform. A layout effect
  // so it runs before paint and the bar cannot show a double offset for one
  // frame. A no-op until a preview has actually written a property, so it can
  // never wipe the bar's React-set width on mount.
  useIsomorphicLayoutEffect(() => {
    if (dragging) return;
    // A committed drop parked a glide: React has just re-rendered the bar at its
    // new slot, so ease the inline preview styles to the values React now owns.
    // The start transform subtracts the snapped distance, matching React's new
    // `left`, so the bar's screen position is unbroken at the swap.
    const glide = glideRef.current;
    if (glide) {
      glideRef.current = null;
      const el = ref.current;
      if (el) {
        el.style.transition = "none";
        if (glide.startTransform) el.style.transform = glide.startTransform;
        if (glide.startWidth) el.style.width = glide.startWidth;
        // Flush the start frame so the browser has a from-value to ease from.
        void el.offsetWidth;
        el.style.transition =
          "transform 190ms var(--ease-spring, ease-out), width 190ms var(--ease-spring, ease-out)";
        if (glide.endTransform) el.style.transform = glide.endTransform;
        if (glide.endWidth) el.style.width = glide.endWidth;
        window.setTimeout(() => {
          // A new drag may have taken over the element; never wipe its preview.
          if (sessionRef.current) return;
          el.style.transition = "";
          resetPreview(el);
        }, 210);
      }
      return;
    }
    if (!previewTransformRef.current && !previewWidthRef.current) return;
    resetPreview(ref.current);
  }, [dragging, task.start_date, task.due_date, task.board_section_id, resetPreview]);

  useEffect(
    () => () => {
      if (sessionRef.current) finishRef.current(false);
      disarmClickSuppressor();
    },
    [disarmClickSuppressor]
  );

  return { ref, onPointerDown, dragging, resizePreview };
}
