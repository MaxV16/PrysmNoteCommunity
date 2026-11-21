"use client";

import { memo, useMemo, type CSSProperties } from "react";
import { todayStart } from "@/lib/dates";
import { DAY_HEADER_HEIGHT } from "./constants";

interface TimelineHeaderProps {
  days: Date[];
  dayWidth?: number;
  /** Live current day from `useTimeline`, so the highlight survives midnight. */
  today?: Date;
}

/**
 * One day header cell. Its width comes from `--prysm-day-w` on the strip rather
 * than a prop, so zooming the timeline patches one CSS variable instead of
 * re-rendering 260 cells.
 */
const DayHeaderCell = memo(function DayHeaderCell({
  dayName,
  dayNum,
  isToday,
  isWeekend,
}: {
  dayName: string;
  dayNum: number;
  isToday: boolean;
  isWeekend: boolean;
}) {
  return (
    <div
      data-day-header
      data-is-today={isToday ? "true" : "false"}
      data-is-weekend={isWeekend ? "true" : "false"}
      className="flex flex-col items-center justify-center py-2 md:py-3"
      style={{
        width: "var(--prysm-day-w)",
        minWidth: "var(--prysm-day-w)",
        flex: "0 0 var(--prysm-day-w)",
      }}
    >
      <span
        className={`text-[10px] uppercase tracking-[0.08em] text-scale-day font-medium md:text-[11px] ${
          isToday ? "text-accent" : isWeekend ? "text-muted" : "text-secondary"
        }`}
      >
        {dayName}
      </span>
      <span
        className={
          isToday
            ? "mt-0.5 text-lg text-scale-num font-semibold tabular-nums leading-none text-accent md:mt-1 md:text-2xl"
            : `mt-0.5 text-lg text-scale-num font-semibold tabular-nums leading-none md:mt-1 md:text-2xl ${
                isWeekend ? "text-secondary" : "text-primary"
              }`
        }
      >
        {dayNum}
      </span>
    </div>
  );
});

/**
 * Day/date header strip. Memoized and keyed by SLICE INDEX, not by date: when
 * the rendered slice shifts, the 260 cells are patched in place (text and
 * `data-is-today` update) instead of being unmounted and recreated, which was a
 * ~150ms freeze every time the slice moved.
 */
export const TimelineHeader = memo(function TimelineHeader({
  days,
  dayWidth = 120,
  today,
}: TimelineHeaderProps) {
  // Split from the strip so a zoom step (new `dayWidth` only) does not walk the
  // cells: `days` and `todayMs` are unchanged, so this memo bails out.
  const rows = useMemo(() => {
    const current = new Date(today ?? todayStart());
    current.setHours(0, 0, 0, 0);
    const currentMs = current.getTime();
    // One formatter for the whole slice: `toLocaleDateString` with options
    // builds/looks up an Intl.DateTimeFormat per call, 260 times per slice.
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
    return days.map((day) => {
      const d = new Date(day);
      d.setHours(0, 0, 0, 0);
      return {
        dayName: weekday.format(d),
        dayNum: d.getDate(),
        isToday: d.getTime() === currentMs,
        isWeekend: d.getDay() === 0 || d.getDay() === 6,
      };
    });
  }, [days, today]);

  return (
    <div
      className="flex border-b border-border bg-surface sticky top-0 z-30 shrink-0"
      style={
        {
          width: "100%",
          minWidth: "max-content",
          height: DAY_HEADER_HEIGHT,
          "--prysm-day-w": `${dayWidth}px`,
        } as CSSProperties
      }
    >
      {rows.map((row, index) => (
        <DayHeaderCell key={`hdr-${index}`} {...row} />
      ))}
    </div>
  );
});
