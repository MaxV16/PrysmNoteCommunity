"use client";

import { useEffect, useRef } from "react";

/**
 * Links two scrollable elements' vertical scroll positions so they stay in
 * sync in BOTH directions (the left labels column and the day grid body).
 * A guard flag prevents the two scroll listeners from ping-ponging, and the
 * write is RAF-batched so each frame performs at most one scroll assignment.
 */
export function useSyncScroll(
  aRef: React.RefObject<HTMLDivElement | null>,
  bRef: React.RefObject<HTMLDivElement | null>,
  // Re-runs the effect when the elements (re)appear: the labels column mounts
  // only after sections load, so a one-shot effect attached nothing and the
  // columns stayed out of sync. Pass the state that gates their rendering.
  deps: unknown[] = [],
) {
  const rafRef = useRef(0);
  const syncingRef = useRef(false);

  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b) return;

    const link = (from: HTMLDivElement, to: HTMLDivElement) => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (syncingRef.current) return;
        if (to.scrollTop === from.scrollTop) return;
        syncingRef.current = true;
        to.scrollTop = from.scrollTop;
        requestAnimationFrame(() => {
          syncingRef.current = false;
        });
      });
    };

    const onAScroll = link(a, b);
    const onBScroll = link(b, a);
    a.addEventListener("scroll", onAScroll);
    b.addEventListener("scroll", onBScroll);
    return () => {
      a.removeEventListener("scroll", onAScroll);
      b.removeEventListener("scroll", onBScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [aRef, bRef, ...deps]);
}
