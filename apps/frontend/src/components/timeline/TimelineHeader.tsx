"use client";

import { memo, useMemo } from "react";
import { todayStart } from "@/lib/dates";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineHeaderProps {
  days: Date[];
  dayWidth?: number;
}

/**
 * Day/date header strip. Memoized and keyed by SLICE INDEX, not by date: when
 * the rendered slice shifts, the 260 cells are patched in place (text and
 * `data-is-today` update) instead of being unmounted and recreated, which was a
 * ~150ms freeze every time the slice moved.
 */
export const TimelineHeader = memo(function TimelineHeader({ days, dayWidth = 120 }: TimelineHeaderProps) {
  const dayRows = useMemo(() => {
    const today = todayStart();
    return days.map((day) => {
      const d = new Date(day);
      d.setHours(0, 0, 0, 0);
      const isToday = d.getTime() === today.getTime();
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = d.getDate();
      return { dayName, dayNum, isToday };
    });
  }, [days]);

  return (
    <div className="flex border-b border-border bg-surface sticky top-0 z-20 shrink-0" style={{ width: "100%", minWidth: "max-content", height: DAY_HEADER_HEIGHT }}>
      {dayRows.map(({ dayName, dayNum, isToday }, index) => (
        <div
          key={`hdr-${index}`}
          data-day-header
          data-is-today={isToday ? "true" : "false"}
          className="flex flex-col items-center justify-center py-2 md:py-3"
          style={{ width: dayWidth, minWidth: dayWidth, flex: `0 0 ${dayWidth}px` }}
        >
          <span className={`text-[11px] font-medium md:text-xs ${isToday ? "text-accent" : "text-secondary"}`}>
            {dayName}
          </span>
          <span
            className={`mt-0.5 text-lg font-semibold tabular-nums leading-none md:mt-1 md:text-2xl ${isToday ? "text-accent" : "text-primary"}`}
          >
            {dayNum}
          </span>
        </div>
      ))}
    </div>
  );
});
