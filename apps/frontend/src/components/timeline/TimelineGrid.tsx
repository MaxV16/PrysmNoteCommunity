"use client";

import { useMemo } from "react";

interface TimelineGridProps {
  days: Date[];
}

export function TimelineGrid({ days }: TimelineGridProps) {
  const dayWidth = `${100 / days.length}%`;

  const todayIndex = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return days.findIndex((d) => {
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      return day.getTime() === today.getTime();
    });
  }, [days]);

  return (
    <div className="absolute inset-0 pointer-events-none flex min-h-full">
      {days.map((day, i) => {
        const d = new Date(day);
        d.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isToday = d.getTime() === today.getTime();
        return (
          <div
            key={day.toISOString()}
            className="border-r border-border/80 min-h-full"
            style={{ width: dayWidth }}
          >
            {isToday && (
              <div className="h-full w-full bg-accent/5" />
            )}
          </div>
        );
      })}
    </div>
  );
}