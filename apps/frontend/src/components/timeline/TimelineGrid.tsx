"use client";

import { useMemo } from "react";

interface TimelineGridProps {
  days: Date[];
}

export function TimelineGrid({ days }: TimelineGridProps) {
  const todayStr = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none flex" style={{ minHeight: "100%" }}>
      {days.map((day) => {
        const d = new Date(day);
        d.setHours(0, 0, 0, 0);
        const isToday = d.toISOString() === todayStr;
        return (
          <div
            key={day.toISOString()}
            className="border-r border-border/30"
            style={{
              minWidth: 120,
              flex: 1,
              backgroundColor: isToday ? "var(--accent)" : undefined,
              opacity: isToday ? 0.04 : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
