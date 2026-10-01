"use client";

import { memo, useMemo } from "react";
import { todayStart } from "@/lib/dates";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineGridProps {
  days: Date[];
  dayWidth?: number;
}

/**
 * Day-column background grid. Memoized and keyed by SLICE INDEX, not by date,
 * so a slice shift patches the 260 columns in place (updating `data-is-today`)
 * instead of recreating them, which caused a visible freeze while scrolling.
 */
export const TimelineGrid = memo(function TimelineGrid({ days, dayWidth = 120 }: TimelineGridProps) {
  const todayStr = useMemo(() => todayStart().toISOString(), []);

  return (
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ top: DAY_HEADER_HEIGHT, minHeight: `calc(100% - ${DAY_HEADER_HEIGHT}px)` }}>
      {/* Vertical day columns */}
      <div className="flex" style={{ minHeight: "100%" }}>
        {days.map((day, index) => {
          const d = new Date(day);
          d.setHours(0, 0, 0, 0);
          const isToday = d.toISOString() === todayStr;
          const dow = d.getDay();
          const isWeekend = dow === 0 || dow === 6;
          return (
            <div
              key={`col-${index}`}
              data-day-column
              data-is-today={isToday ? "true" : "false"}
              data-is-weekend={isWeekend ? "true" : "false"}
              className="relative"
              style={{
                width: dayWidth,
                minWidth: dayWidth,
                flex: `0 0 ${dayWidth}px`,
                backgroundColor: isToday
                  ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                  : isWeekend
                  ? "var(--weekend-tint)"
                  : undefined,
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
});
