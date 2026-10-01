"use client";

import { useCallback, useEffect, useRef } from "react";

interface LongPressPoint {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

interface UseLongPressOptions {
  delay?: number;
  disabled?: boolean;
}

// How long after the pointer is released the follow-up click is still
// suppressed. The click after a long-press arrives right after release, while a
// drag/pick-up produces no click at all, so this window bounds the suppressor
// and keeps it from swallowing the user's next, unrelated tap (F2).
const CLICK_SUPPRESS_MS = 400;
const MOVE_TOLERANCE_PX = 10;

interface Suppressor {
  handler: (ev: Event) => void;
  onRelease: () => void;
  onCancel: () => void;
  expiry: number | null;
}

/**
 * Long-press detection for touch (pointer: coarse) context menus.
 *
 * A press is "long" when the pointer stays within ~10px for `delay` ms without
 * lifting. Movement cancels it so drag gestures (dnd-kit TouchSensor -
 * delay-constrained) behave normally. When the press fires, the following
 * ``click`` is suppressed at the window capture phase so the element's regular
 * onClick (open details / select) does not also fire.
 *
 * The suppressor is disarmed on the first suppressed click, on pointercancel,
 * or CLICK_SUPPRESS_MS after pointerup, whichever comes first, so a long-press
 * that turns into a drag never eats the next tap.
 *
 * Returns pointer handlers to spread onto the element.
 */
export function useLongPress(
  onLongPress: ((point: LongPressPoint) => void) | undefined,
  opts: UseLongPressOptions = {}
) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const suppressorRef = useRef<Suppressor | null>(null);

  const disarmSuppressor = useCallback(() => {
    const suppressor = suppressorRef.current;
    if (!suppressor) return;
    window.removeEventListener("click", suppressor.handler, true);
    window.removeEventListener("pointerup", suppressor.onRelease, true);
    window.removeEventListener("pointercancel", suppressor.onCancel, true);
    if (suppressor.expiry !== null) window.clearTimeout(suppressor.expiry);
    suppressorRef.current = null;
  }, []);

  const clearPress = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const scheduleDisarm = useCallback(
    (ms: number) => {
      const suppressor = suppressorRef.current;
      if (!suppressor) return;
      if (suppressor.expiry !== null) window.clearTimeout(suppressor.expiry);
      suppressor.expiry = window.setTimeout(disarmSuppressor, ms);
    },
    [disarmSuppressor]
  );

  const armSuppressor = useCallback(() => {
    disarmSuppressor();
    const handler = (ev: Event) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      disarmSuppressor();
    };
    // Bound the suppressor from the release too: a drag/pick-up may end
    // without our element handler seeing the pointerup, and an unbounded
    // window listener would then swallow the next tap.
    const onRelease = () => scheduleDisarm(CLICK_SUPPRESS_MS);
    const onCancel = () => disarmSuppressor();
    suppressorRef.current = { handler, onRelease, onCancel, expiry: null };
    window.addEventListener("click", handler, { capture: true });
    window.addEventListener("pointerup", onRelease, { capture: true, once: true });
    window.addEventListener("pointercancel", onCancel, { capture: true, once: true });
  }, [disarmSuppressor, scheduleDisarm]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // A stale suppressor from a previous gesture must never eat this press.
      disarmSuppressor();
      if (opts.disabled || !onLongPress) return;
      if (e.pointerType !== "touch") return;
      clearPress();
      firedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      const start = startRef.current;
      const target = e.target;
      timerRef.current = window.setTimeout(() => {
        if (!startRef.current) return;
        armSuppressor();
        firedRef.current = true;
        onLongPress({ clientX: start.x, clientY: start.y, target });
      }, opts.delay ?? 500);
    },
    [armSuppressor, clearPress, disarmSuppressor, onLongPress, opts.delay, opts.disabled]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      if (
        Math.abs(e.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(e.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        clearPress();
      }
    },
    [clearPress]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (firedRef.current) {
        // Keep the suppression active for this pointerup's click, then bound it
        // so a drag/pick-up (which produces no click) cannot leave it armed.
        e.preventDefault();
        scheduleDisarm(CLICK_SUPPRESS_MS);
      }
      clearPress();
    },
    [clearPress, scheduleDisarm]
  );

  const onPointerCancel = useCallback(() => {
    clearPress();
    disarmSuppressor();
  }, [clearPress, disarmSuppressor]);

  useEffect(() => {
    return () => {
      clearPress();
      disarmSuppressor();
    };
  }, [clearPress, disarmSuppressor]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
