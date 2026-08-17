"use client";

import { useState, useMemo, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { parseLocalDate } from "@/lib/utils";

/**
 * Infinite horizontal timeline state.
 *
 * `scrollOffset` is the number of days between "today" and the leftmost rendered
 * day (can be positive or negative). `days` is the total number of day columns
 * currently rendered. Expanding grows the rendered window (never shrinks), which
 * lets the DOM keep growing so the user can scroll indefinitely in both directions.
 */
export function useTimeline(initialDays = 20, baseLeftOffset = 10) {
  const tasks = useAppStore((s) => s.tasks);
  const [days, setDays] = useState(initialDays);
  const [scrollOffset, setScrollOffset] = useState(-baseLeftOffset);

  const expandBackward = useCallback((amount: number) => {
    setScrollOffset((prev) => prev - amount);
    setDays((prev) => prev + amount);
  }, []);

  const expandForward = useCallback((amount: number) => {
    // Only grow rightward; do not shift the left edge.
    setDays((prev) => prev + amount);
  }, []);

  const setRightEdge = useCallback((startOffset: number, count: number) => {
    setScrollOffset(startOffset);
    setDays((prev) => Math.max(prev, count));
  }, []);

  const visibleRange = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + scrollOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    return { start, end };
  }, [scrollOffset, days]);

  const visibleTasks = useMemo(
    () =>
      tasks.filter((t) => {
        if (!t.start_date && !t.due_date) return false;
        const taskDate = parseLocalDate(t.start_date || t.due_date || "");
        if (Number.isNaN(taskDate.getTime())) return false;
        return taskDate >= visibleRange.start && taskDate <= visibleRange.end;
      }),
    [tasks, visibleRange]
  );

  return {
    visibleTasks,
    visibleRange,
    scrollOffset,
    setScrollOffset,
    viewDays: days,
    expandBackward,
    expandForward,
    setRightEdge,
  };
}
