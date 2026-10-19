"use client";

import { memo } from "react";
import { todayStart } from "@/lib/dates";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineGridProps {
  days: Date[];
  dayWidth?: number;
  /**
   * The live current day, owned by `useTimeline` (which re-resolves it on an
   * interval and when the tab wakes). Reading `todayStart()` inside this
   * component would freeze the marker on the day the timeline mounted, so a
   * session left open across midnight kept the line on yesterday.
   */
  today?: Date;
}

function atLocalMidnight(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Day-column background grid. Memoized and keyed by SLICE INDEX, not by date,
 * so a slice shift patches the 260 columns in place (updating `data-is-today`)
 * instead of recreating them, which caused a visible freeze while scrolling.
 */
export const TimelineGrid = memo(function TimelineGrid({
  days,
  dayWidth = 120,
  today,
}: TimelineGridProps) {
  const todayMs = atLocalMidnight(today ?? todayStart()).getTime();

  return (
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ top: DAY_HEADER_HEIGHT, minHeight: `calc(100% - ${DAY_HEADER_HEIGHT}px)`, backgroundColor: "var(--timeline-bg)" }}>
      {/* Vertical day columns */}
      <div className="flex" style={{ minHeight: "100%" }}>
        {days.map((day, index) => {
          const d = new Date(day);
          d.setHours(0, 0, 0, 0);
          const isToday = d.getTime() === todayMs;
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
                borderLeft:
                  index === 0
                    ? undefined
                    : "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                backgroundColor: isToday
                  ? "color-mix(in srgb, var(--accent) 7%, transparent)"
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
                    opacity: 0.9,
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
