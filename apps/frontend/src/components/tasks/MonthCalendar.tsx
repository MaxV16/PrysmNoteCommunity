"use client";

import { useEffect, useMemo, useState } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

interface MonthCalendarProps {
  value: string | null; // ISO date string
  onChange: (iso: string) => void;
  accent?: string;
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function MonthCalendar({ value, onChange, accent = "var(--accent)" }: MonthCalendarProps) {
  const parsed = useMemo(() => (value ? new Date(value) : null), [value]);
  const [viewYear, setViewYear] = useState(() => parsed?.getFullYear() ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (parsed ? parsed.getMonth() : new Date().getMonth()));

  // Keep the visible month aligned with the selected date (e.g. after a quick
  // action changes the date, or when the popover is opened for an old task).
  useEffect(() => {
    if (parsed && !isNaN(parsed.getTime())) {
      setViewYear(parsed.getFullYear());
      setViewMonth(parsed.getMonth());
    }
  }, [parsed]);

  const year = viewYear;
  const month = viewMonth;
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;

  const prevMonth = () => {
    if (month === 0) {
      setViewMonth(11);
      setViewYear(year - 1);
    } else {
      setViewMonth(month - 1);
    }
  };
  const nextMonth = () => {
    if (month === 11) {
      setViewMonth(0);
      setViewYear(year + 1);
    } else {
      setViewMonth(month + 1);
    }
  };

  const todayStr = toDateOnly(new Date());

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prevMonth} className="text-xs text-muted hover:text-primary p-0.5">
          ‹
        </button>
        <span className="text-xs font-semibold text-primary">{MONTHS[month]} {year}</span>
        <button type="button" onClick={nextMonth} className="text-xs text-muted hover:text-primary p-0.5">
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {DAY_HEADERS.map((h) => (
          <span key={h} className="text-[10px] text-muted font-medium py-0.5">{h}</span>
        ))}
        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}
        {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
          const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isSelected = ds === value;
          const isToday = ds === todayStr;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange(ds)}
              className="text-xs py-1 rounded-md transition-colors hover:bg-hover"
              style={isSelected ? { backgroundColor: accent, color: "#fff", fontWeight: 600 } : isToday ? { backgroundColor: accent + "22", color: accent, fontWeight: 500 } : undefined}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
