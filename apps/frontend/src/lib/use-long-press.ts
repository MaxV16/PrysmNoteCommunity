"use client";

import { useCallback, useRef } from "react";

interface LongPressPoint {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

interface UseLongPressOptions {
  delay?: number;
  disabled?: boolean;
}

/**
 * Long-press detection for touch (pointer: coarse) context menus.
 *
 * A press is "long" when the pointer stays within ~10px for `delay` ms without
 * lifting. Movement cancels it so drag gestures (dnd-kit PointerSensor -
 * distance-constrained) behave normally. When the press fires, the following
 * ``click`` is suppressed at the window capture phase so the element's regular
 * onClick (open details / select) does not also fire.
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

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (opts.disabled || !onLongPress) return;
      if (e.pointerType !== "touch") return;
      clear();
      firedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      const start = startRef.current;
      const target = e.target;
      timerRef.current = window.setTimeout(() => {
        if (!startRef.current) return;
        // Suppress the click that follows a fired long-press (capture phase,
        // before React's delegating root listener runs).
        const suppress = (ev: Event) => {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        firedRef.current = true;
        onLongPress({ clientX: start.x, clientY: start.y, target });
      }, opts.delay ?? 500);
    },
    [clear, onLongPress, opts.delay, opts.disabled]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) {
        clear();
      }
    },
    [clear]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (firedRef.current) {
        // Keep the suppression active for the pointerup's click as well.
        e.preventDefault();
      }
      clear();
    },
    [clear]
  );

  const onPointerCancel = useCallback(() => {
    clear();
  }, [clear]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}