"use client";

import { useState, useMemo, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";

export function useTimeline(initialDays = 14) {
  const tasks = useAppStore((s) => s.tasks);
  const [days, setDays] = useState(initialDays);
  const [scrollOffset, setScrollOffset] = useState(0);

  const expandBackward = useCallback((amount: number) => {
    setScrollOffset((prev) => prev - amount);
  }, []);

  const expandForward = useCallback((amount: number) => {
    setScrollOffset((prev) => prev + amount);
  }, []);

  const visibleRange = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() + scrollOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    return { start, end };
  }, [scrollOffset, days]);

  const visibleTasks = useMemo(
    () =>
      tasks.filter((t) => {
        if (!t.start_date && !t.due_date) return false;
        const taskDate = new Date(t.start_date || t.due_date || "");
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
  };
}
