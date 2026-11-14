"use client";

import { memo, type CSSProperties } from "react";
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
 * One day column. The width comes from `--prysm-day-w` on the strip, not from a
 * prop, so a zoom step (which only changes that variable) never re-renders any
 * column: React sees identical props and skips all 260 of them.
 */
const DayColumn = memo(function DayColumn({
  first,
  isToday,
  isWeekend,
}: {
  first: boolean;
  isToday: boolean;
  isWeekend: boolean;
}) {
  return (
    <div
      data-day-column
      data-is-today={isToday ? "true" : "false"}
      data-is-weekend={isWeekend ? "true" : "false"}
      className="relative"
      style={{
        width: "var(--prysm-day-w)",
        minWidth: "var(--prysm-day-w)",
        flex: "0 0 var(--prysm-day-w)",
        borderLeft: first
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
});

/**
 * The column strip. Split out and memoized on `days` + `todayMs` so a zoom step
 * touches only the CSS variable above it instead of walking the whole strip.
 */
const DayColumns = memo(function DayColumns({
  days,
  todayMs,
}: {
  days: Date[];
  todayMs: number;
}) {
  return (
    <div className="flex" style={{ minHeight: "100%" }}>
      {days.map((day, index) => {
        const d = atLocalMidnight(day).getTime();
        const dow = new Date(day).getDay();
        return (
          <DayColumn
            key={`col-${index}`}
            first={index === 0}
            isToday={d === todayMs}
            isWeekend={dow === 0 || dow === 6}
          />
        );
      })}
    </div>
  );
});

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
    <div
      className="absolute inset-x-0 bottom-0 pointer-events-none"
      style={
        {
          top: DAY_HEADER_HEIGHT,
          minHeight: `calc(100% - ${DAY_HEADER_HEIGHT}px)`,
          backgroundColor: "var(--timeline-bg)",
          "--prysm-day-w": `${dayWidth}px`,
        } as CSSProperties
      }
    >
      <DayColumns days={days} todayMs={todayMs} />
    </div>
  );
});
