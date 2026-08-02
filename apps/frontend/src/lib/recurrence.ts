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
