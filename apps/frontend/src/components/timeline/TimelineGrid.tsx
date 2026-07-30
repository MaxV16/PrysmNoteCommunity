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
    <div className="absolute inset-0 pointer-events-none" style={{ minHeight: "100%" }}>
      {/* Vertical day columns */}
      <div className="flex" style={{ minHeight: "100%" }}>
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
            >
              {isToday && (
                <div className="absolute inset-y-0" style={{ left: "50%", width: 2, transform: "translateX(-50%)", backgroundColor: "var(--accent)", boxShadow: "0 0 8px var(--accent), 0 0 16px var(--accent-glow)" }} />
              )}
            </div>
          );
        })}
      </div>
      {/* Horizontal grid lines */}
      <div className="absolute inset-0 flex flex-col pointer-events-none" style={{ paddingTop: 0 }}>
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i} className="border-b border-border/10" style={{ flex: 1, minHeight: 48 }} />
        ))}
      </div>
    </div>
  );
}
