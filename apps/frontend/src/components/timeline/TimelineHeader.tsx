"use client";

import { useMemo } from "react";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineHeaderProps {
  days: Date[];
  dayWidth?: number;
}

export function TimelineHeader({ days, dayWidth = 120 }: TimelineHeaderProps) {
  const dayRows = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return days.map((day) => {
      const d = new Date(day);
      d.setHours(0, 0, 0, 0);
      const isToday = d.getTime() === today.getTime();
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = d.getDate();
      return { dayName, dayNum, isToday, key: d.toISOString() };
    });
  }, [days]);

  return (
    <div className="flex border-b border-border bg-surface sticky top-0 z-20 shrink-0" style={{ width: "100%", minWidth: "max-content", height: DAY_HEADER_HEIGHT }}>
      {dayRows.map(({ dayName, dayNum, isToday, key }) => (
        <div
          key={key}
          data-day-header
          data-is-today={isToday ? "true" : "false"}
          className="flex flex-col items-center justify-center py-3"
          style={{ width: dayWidth, minWidth: dayWidth, flex: `0 0 ${dayWidth}px` }}
        >
          <span className={`text-xs font-medium ${isToday ? "text-accent" : "text-secondary"}`}>
            {dayName}
          </span>
          <span
            className={`mt-1 text-2xl font-semibold tabular-nums leading-none ${isToday ? "text-accent" : "text-primary"}`}
          >
            {dayNum}
          </span>
        </div>
      ))}
    </div>
  );
}
