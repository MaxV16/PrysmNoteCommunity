"use client";

import { useMemo } from "react";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineGridProps {
  days: Date[];
  dayWidth?: number;
}

export function TimelineGrid({ days, dayWidth = 120 }: TimelineGridProps) {
  const todayStr = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  return (
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ top: DAY_HEADER_HEIGHT, minHeight: `calc(100% - ${DAY_HEADER_HEIGHT}px)` }}>
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
                width: dayWidth,
                minWidth: dayWidth,
                flex: `0 0 ${dayWidth}px`,
                backgroundColor: isToday ? "color-mix(in srgb, var(--accent) 10%, transparent)" : undefined,
              }}
            >
              {isToday && (
                <div
                  data-today-indicator
                  className="absolute inset-y-0"
                  style={{
                    left: "50%",
                    width: 2,
                    transform: "translateX(-50%)",
                    backgroundColor: "var(--accent)",
                    opacity: 0.55,
                    boxShadow: "0 0 6px var(--accent)",
                    zIndex: 0,
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
