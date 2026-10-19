"use client";

import { memo, useMemo } from "react";
import { todayStart } from "@/lib/dates";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineHeaderProps {
  days: Date[];
  dayWidth?: number;
  /** Live current day from `useTimeline`, so the highlight survives midnight. */
  today?: Date;
}

/**
 * Day/date header strip. Memoized and keyed by SLICE INDEX, not by date: when
 * the rendered slice shifts, the 260 cells are patched in place (text and
 * `data-is-today` update) instead of being unmounted and recreated, which was a
 * ~150ms freeze every time the slice moved.
 */
export const TimelineHeader = memo(function TimelineHeader({
  days,
  dayWidth = 120,
  today,
}: TimelineHeaderProps) {
  const dayRows = useMemo(() => {
    const current = new Date(today ?? todayStart());
    current.setHours(0, 0, 0, 0);
    const currentMs = current.getTime();
    return days.map((day) => {
      const d = new Date(day);
      d.setHours(0, 0, 0, 0);
      const isToday = d.getTime() === currentMs;
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = d.getDate();
      return { dayName, dayNum, isToday, isWeekend };
    });
  }, [days, today]);

  return (
    <div className="flex border-b border-border bg-surface sticky top-0 z-30 shrink-0" style={{ width: "100%", minWidth: "max-content", height: DAY_HEADER_HEIGHT }}>
      {dayRows.map(({ dayName, dayNum, isToday, isWeekend }, index) => (
        <div
          key={`hdr-${index}`}
          data-day-header
          data-is-today={isToday ? "true" : "false"}
          data-is-weekend={isWeekend ? "true" : "false"}
          className="flex flex-col items-center justify-center py-2 md:py-3"
          style={{ width: dayWidth, minWidth: dayWidth, flex: `0 0 ${dayWidth}px` }}
        >
          <span
            className={`text-[10px] uppercase tracking-[0.08em] text-scale-day font-medium md:text-[11px] ${
              isToday ? "text-accent" : isWeekend ? "text-muted" : "text-secondary"
            }`}
          >
            {dayName}
          </span>
          <span
            className={
              isToday
                ? "mt-0.5 text-lg text-scale-num font-semibold tabular-nums leading-none text-accent md:mt-1 md:text-2xl"
                : `mt-0.5 text-lg text-scale-num font-semibold tabular-nums leading-none md:mt-1 md:text-2xl ${
                    isWeekend ? "text-secondary" : "text-primary"
                  }`
            }
          >
            {dayNum}
          </span>
        </div>
      ))}
    </div>
  );
});
