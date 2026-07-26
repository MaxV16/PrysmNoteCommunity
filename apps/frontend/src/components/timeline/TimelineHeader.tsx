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
            className="flex flex-col items-center justify-end border-r border-border pb-1 pt-2"
            style={{ minWidth: 120, flex: 1 }}
          >
            <span className={`text-[10px] font-medium uppercase tracking-wide ${
              isToday ? "text-accent" : "text-muted"
            }`}>
              {dayName}
            </span>
            <span
              className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                isToday ? "bg-accent text-base" : "text-secondary"
              }`}
            >
              {dayNum}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
