"use client";

import { readPreferenceCache } from "./preferences";

export interface DatePrefs {
  dateFormat: string;
  timeFormat: string;
  timeZone?: string;
  startDay: "monday" | "sunday";
}

let cachedPrefs: DatePrefs | null = null;

/**
 * Read a setting that may be stored either JSON-encoded (the settings page uses
 * `JSON.stringify`) or as a raw legacy string (older builds / the timezone
 * sync hook). Also falls back to the server-hydrated `prysm_preferences` cache
 * so a preference set on another device is honoured.
 */
function readSetting(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") return parsed;
      } catch {
        /* legacy raw value */
      }
      return raw;
    }
  } catch {
    /* storage unavailable */
  }
  const cached = readPreferenceCache()[key];
  return typeof cached === "string" ? cached : null;
}

/** Validate an IANA timezone name; returns undefined when unusable. */
export function isValidTimeZone(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return undefined;
  }
}

export function getDatePrefs(): DatePrefs {
  if (cachedPrefs) return cachedPrefs;
  if (typeof window === "undefined") {
    return { dateFormat: "dd/mm/yyyy", timeFormat: "24h", timeZone: undefined, startDay: "monday" };
  }
  try {
    const dateFormat = readSetting("prysm_date_format") || "dd/mm/yyyy";
    const timeFormat = readSetting("prysm_time_format") || "24h";
    const timeZone = isValidTimeZone(readSetting("prysm_tz"));
    const startDay = readSetting("prysm_start_day") === "sunday" ? "sunday" : "monday";
    cachedPrefs = { dateFormat, timeFormat, timeZone, startDay };
    return cachedPrefs;
  } catch {
    return { dateFormat: "dd/mm/yyyy", timeFormat: "24h", timeZone: undefined, startDay: "monday" };
  }
}

/** Invalidate the cached prefs so the next call re-reads localStorage. */
export function invalidateDatePrefs(): void {
  cachedPrefs = null;
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
    const y = get("year"), m = get("month"), dd = get("day");
    const ny = Number(y), nm = Number(m), nd = Number(dd);
    if (Number.isNaN(ny) || Number.isNaN(nm) || Number.isNaN(nd) || ny < 2000 || ny > 2100) {
      return { y: String(d.getFullYear()), m: pad(d.getMonth() + 1), dd: pad(d.getDate()) };
    }
    return { y, m, dd };
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
 *
 * A `YYYY-MM-DD` string is a calendar date, so it is rendered literally and
 * never timezone-shifted (parsing it as a Date would treat it as UTC midnight,
 * which displays as the previous day in negative-offset timezones). All other
 * inputs are instant/datetime values and are converted into `prysm_tz`.
 */
export function formatDate(date: Date | string, opts?: { includeYear?: boolean }): string {
  const includeYear = opts?.includeYear ?? true;
  const render = (dd: string, mm: string, yyyy: string): string => {
    switch (getDatePrefs().dateFormat) {
      case "mm/dd/yyyy":
        return includeYear ? `${mm}/${dd}/${yyyy}` : `${mm}/${dd}`;
      case "yyyy-mm-dd":
        return includeYear ? `${yyyy}-${mm}-${dd}` : `${mm}-${dd}`;
      case "dd/mm/yyyy":
      default:
        return includeYear ? `${dd}/${mm}/${yyyy}` : `${dd}/${mm}`;
    }
  };

  // Date-only string: use its literal calendar parts.
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [yyyy, mm, dd] = date.split("-");
    return render(dd, mm, yyyy);
  }

  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const { timeZone } = getDatePrefs();
  if (timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone,
      });
      const parts = fmt.formatToParts(d);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
      return render(get("day"), get("month"), get("year"));
    } catch {
      /* fall through to browser-local parts */
    }
  }
  return render(pad(d.getDate()), pad(d.getMonth() + 1), String(d.getFullYear()));
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
