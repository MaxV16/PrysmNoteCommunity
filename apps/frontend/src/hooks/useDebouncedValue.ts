"use client";

import { useEffect, useState } from "react";

/**
 * Delay a rapidly changing value, so expensive derived work (filtering
 * thousands of tasks, re-sorting a board) runs once after typing settles
 * instead of once per keystroke. The first value is returned immediately, so a
 * restored or preset query is never delayed.
 */
export function useDebouncedValue<T>(value: T, delayMs = 180): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}
