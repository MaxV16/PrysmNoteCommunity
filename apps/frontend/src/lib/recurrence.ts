"use client";

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface CustomRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  byDay?: string; // e.g. "MO", "TH", "WE", or "WORKDAY"
  dayOfMonth?: number; // 1-31
  anchor: "due" | "completion";
  skipWeekends: boolean;
}

/** How a recurrence stops: never (endless), on a calendar date, or after N times. */
export type RecurrenceEnd =
  | { kind: "never" }
  | { kind: "date"; date: string }
  | { kind: "count"; count: number };

/**
 * Remove any trailing `;COUNT=` / `;UNTIL=` clause from an RRULE so a new end
 * condition can be re-applied without stacking stale ones.
 */
export function stripEnd(rrule: string): string {
  return rrule
    .split(";")
    .filter((part) => part && !/^(COUNT|UNTIL)=/i.test(part))
    .join(";");
}

/**
 * Encode an end condition onto a base RRULE. Date-based ends live in the
 * `recurrence_end_date` column (already honored by expansion + ended-template
 * filters); count-based ends are appended to the rule as `;COUNT=N` (honored
 * natively by rrulestr).
 */
export function applyEnd(
  rule: string,
  end: RecurrenceEnd
): { recurrence_rule: string; recurrence_end_date: string | null } {
  const base = stripEnd(rule);
  switch (end.kind) {
    case "never":
      return { recurrence_rule: base, recurrence_end_date: null };
    case "date":
      return { recurrence_rule: base, recurrence_end_date: end.date };
    case "count": {
      const count = Math.max(1, Math.floor(end.count) || 1);
      return {
        recurrence_rule: base ? `${base};COUNT=${count}` : "",
        recurrence_end_date: null,
      };
    }
  }
}

/**
 * Reverse of applyEnd: derive the end condition for prefill when editing an
 * existing task. Reads `COUNT=`/`UNTIL=` from the rule first, then falls back
 * to the persisted `recurrence_end_date` column, then "never".
 */
export function parseEnd(
  rule: string | null | undefined,
  recurrenceEndDate: string | null | undefined
): RecurrenceEnd {
  if (rule) {
    const countMatch = /(?:^|;)COUNT=(\d+)/i.exec(rule);
    if (countMatch) {
      return { kind: "count", count: Math.max(1, parseInt(countMatch[1], 10) || 1) };
    }
    const untilMatch = /(?:^|;)UNTIL=(\d{8})/i.exec(rule);
    if (untilMatch) {
      const raw = untilMatch[1];
      return {
        kind: "date",
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      };
    }
  }
  if (recurrenceEndDate) {
    return { kind: "date", date: recurrenceEndDate };
  }
  return { kind: "never" };
}

/**
 * Resolve a display recurrence into an RRULE string understood by the backend
 * (e.g. "FREQ=WEEKLY;INTERVAL=2"). Presets derive the trailing attr from the
 * selected date's weekday / day-of-month.
 */
export function toRRule(input: { type: string; freq?: RecurrenceFrequency; interval?: number; byDay?: string; dayOfMonth?: number; anchor?: string; skipWeekends?: boolean }): string {
  switch (input.type) {
    case "none":
      return "";
    case "daily":
      return "FREQ=DAILY";
    case "weekly": {
      const byday = input.byDay || "";
      return byday ? `FREQ=WEEKLY;BYDAY=${byday}` : "FREQ=WEEKLY";
    }
    case "monthly": {
      const dom = input.dayOfMonth || 1;
      return `FREQ=MONTHLY;BYMONTHDAY=${dom}`;
    }
    case "yearly": {
      const dom = input.dayOfMonth || 1;
      return `FREQ=YEARLY;BYMONTHDAY=${dom}`;
    }
    case "weekday":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "custom": {
      const freq = input.freq || "monthly";
      const interval = Math.max(1, input.interval || 1);
      let rrule = `FREQ=${freq.toUpperCase()};INTERVAL=${interval}`;
      if ((freq === "weekly" || freq === "yearly") && input.byDay) {
        rrule += `;BYDAY=${input.byDay}`;
      }
      if (freq === "monthly" && input.dayOfMonth) {
        rrule += `;BYMONTHDAY=${input.dayOfMonth}`;
      }
      if (input.skipWeekends && input.byDay === "WORKDAY") {
        rrule = `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`;
      }
      return rrule;
    }
    default:
      return "";
  }
}

export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export function ordinal(n: number): string {
  const s = n % 10, h = n % 100;
  if (s === 1 && h !== 11) return `${n}st`;
  if (s === 2 && h !== 12) return `${n}nd`;
  if (s === 3 && h !== 13) return `${n}rd`;
  return `${n}th`;
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Descriptive labels for native recurrence presets derived from a selected date,
 * e.g. "Weekly (Thu)", "Monthly (20th)", "Yearly (20 Aug)".
 */
export function recurrencePresetLabel(key: "daily" | "weekly" | "monthly" | "yearly" | "weekday", iso: string): string {
  const day = new Date(iso);
  switch (key) {
    case "daily":
      return "Daily";
    case "weekday":
      return "Every Weekday (Mon–Fri)";
    case "weekly": {
      const dow = WEEKDAY_NAMES[(day.getDay() + 6) % 7];
      return `Weekly (${dow})`;
    }
    case "monthly":
      return `Monthly (${ordinal(day.getDate())})`;
    case "yearly": {
      const month = day.toLocaleDateString("en-US", { month: "short" });
      return `Yearly (${day.getDate()} ${month})`;
    }
  }
}

/** Weekday code (MO..SU) for a JS Date. */
export function weekdayCode(d: Date): string {
  return WEEKDAY_CODES[(d.getDay() + 6) % 7];
}

/** Natural RRULE derived from an existing date (used by quick presets). */
export function dailyWeeklyMonthlyYearly(date: Date, freq: RecurrenceFrequency): string {
  if (freq === "daily") return "FREQ=DAILY";
  if (freq === "weekly") return `FREQ=WEEKLY;BYDAY=${weekdayCode(date)}`;
  if (freq === "monthly") return `FREQ=MONTHLY;BYMONTHDAY=${date.getDate()}`;
  return `FREQ=YEARLY;BYMONTHDAY=${date.getDate()}`;
}

/** A short human label for a recurrence rule, e.g. "Every week on Thu". */
export function describeRule(rrule: string | null | undefined): string | null {
  if (!rrule) return null;
  const up = rrule.toUpperCase();
  if (up.includes("FREQ=DAILY")) return "Daily";
  if (up.includes("FREQ=YEARLY")) return "Yearly";
  if (up.includes("FREQ=WEEKLY")) {
    const m = rrule.match(/BYDAY=([^;]+)/i);
    if (m && m[1] === "MO,TU,WE,TH,FR") return "Every weekday";
    if (m) return `Weekly on ${m[1].slice(0, 2)}`;
    return "Weekly";
  }
  if (up.includes("FREQ=MONTHLY")) return "Monthly";
  return "Repeats";
}
