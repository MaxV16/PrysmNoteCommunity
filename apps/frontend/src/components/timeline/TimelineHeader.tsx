"use client";

import { useMemo } from "react";

interface TimelineHeaderProps {
  days: Date[];
}

export function TimelineHeader({ days }: TimelineHeaderProps) {
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
    <div className="flex border-b border-border bg-surface sticky top-0 z-20 shrink-0">
      <div className="flex" style={{ width: "100%", minWidth: 0 }}>
        {dayRows.map(({ dayName, dayNum, isToday, key }) => (
          <div
            key={key}
            className="flex flex-col items-center justify-center py-3"
            style={{ minWidth: 120, flex: 1 }}
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
    </div>
  );
}
