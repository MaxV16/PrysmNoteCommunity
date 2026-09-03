"use client";

export interface DatePrefs {
  dateFormat: string;
  timeFormat: string;
  timeZone?: string;
  startDay: "monday" | "sunday";
}

export function getDatePrefs(): DatePrefs {
  if (typeof window === "undefined") {
    return { dateFormat: "dd/mm/yyyy", timeFormat: "24h", timeZone: undefined, startDay: "monday" };
  }
  try {
    const dateFormat = localStorage.getItem("prysm_date_format") || "dd/mm/yyyy";
    const timeFormat = localStorage.getItem("prysm_time_format") || "24h";
    const tz = localStorage.getItem("prysm_tz") || undefined;
    const startDay = localStorage.getItem("prysm_start_day") === "sunday" ? "sunday" : "monday";
    return { dateFormat, timeFormat, timeZone: tz || undefined, startDay };
  } catch {
    return { dateFormat: "dd/mm/yyyy", timeFormat: "24h", timeZone: undefined, startDay: "monday" };
  }
}

/** Week start day for calendar grids: 0 = Sunday, 1 = Monday (default). */
export function weekStartsOn(): 0 | 1 {
  return getDatePrefs().startDay === "sunday" ? 0 : 1;
}

/** Leading empty cells before the 1st of the month in a 7-column grid. */
export function calendarOffset(firstDay: Date): number {
  const ws = weekStartsOn();
  return (firstDay.getDay() - ws + 7) % 7;
}

/** Weekday column headers ("Su".."Sa" or "Mo".."Su") matching the pref. */
export function weekdayHeaders(): string[] {
  if (weekStartsOn() === 0) return ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  return ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function tzParts(d: Date): { y: string; m: string; dd: string } {
  const { timeZone } = getDatePrefs();
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return { y: get("year"), m: get("month"), dd: get("day") };
  } catch {
    return { y: String(d.getFullYear()), m: pad(d.getMonth() + 1), dd: pad(d.getDate()) };
  }
}

/** Today's date (YYYY-MM-DD) in the user's configured timezone. */
export function todayISO(): string {
  const p = tzParts(new Date());
  return `${p.y}-${p.m}-${p.dd}`;
}

/** A local Date at midnight of "today" in the user's timezone - used as the
 * timeline's "today" anchor so day columns align with the configured TZ. */
export function todayStart(): Date {
  const p = tzParts(new Date());
  return new Date(`${p.y}-${p.m}-${p.dd}T00:00:00`);
}

/**
 * Format a date according to the user's Date & Time preference
 * (`prysm_date_format`). Patterns: dd/mm/yyyy, mm/dd/yyyy, yyyy-mm-dd.
 */
export function formatDate(date: Date | string, opts?: { includeYear?: boolean }): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const includeYear = opts?.includeYear ?? true;
  const { dateFormat } = getDatePrefs();
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = String(d.getFullYear());
  switch (dateFormat) {
    case "mm/dd/yyyy":
      return includeYear ? `${mm}/${dd}/${yyyy}` : `${mm}/${dd}`;
    case "yyyy-mm-dd":
      return includeYear ? `${yyyy}-${mm}-${dd}` : `${mm}-${dd}`;
    case "dd/mm/yyyy":
    default:
      return includeYear ? `${dd}/${mm}/${yyyy}` : `${dd}/${mm}`;
  }
}

/**
 * Format a time of day according to the user's 12h/24h preference
 * (`prysm_time_format`) and optional timezone (`prysm_tz`).
 */
export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const { timeFormat, timeZone } = getDatePrefs();
  try {
    if (timeFormat === "12h") {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true, timeZone });
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  } catch {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
