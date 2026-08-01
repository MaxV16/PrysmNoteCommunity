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
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ top: 56, minHeight: "calc(100% - 56px)" }}>
      {/* Vertical day columns */}
      <div className="flex" style={{ minHeight: "100%" }}>
        {days.map((day) => {
          const d = new Date(day);
          d.setHours(0, 0, 0, 0);
          const isToday = d.toISOString() === todayStr;
          return (
            <div
              key={day.toISOString()}
              data-day-column
              data-is-today={isToday ? "true" : "false"}
              className="relative"
              style={{
                width: 120,
                minWidth: 120,
                flex: "0 0 120px",
                backgroundColor: isToday ? "color-mix(in srgb, var(--accent) 10%, transparent)" : undefined,
              }}
            >
              {isToday && (
                <div className="absolute inset-y-0" style={{ left: "50%", width: 2, transform: "translateX(-50%)", backgroundColor: "var(--accent)", opacity: 0.8, boxShadow: "0 0 8px var(--accent), 0 0 16px var(--accent-glow)" }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
