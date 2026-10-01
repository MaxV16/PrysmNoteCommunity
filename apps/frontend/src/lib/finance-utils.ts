"use client";

// Pure, no React, so they are trivially testable and shared by the dashboard,
// the hook and the editor. All money math stays in numbers here (display only);
// the ledger itself stores Decimal server-side.

import type { FinancialItem } from "@/hooks/useFinance";

export type StepUnit = "day" | "week" | "month" | "year";

export interface Step {
  unit: StepUnit;
  interval: number;
}

/** Resolve an item's recurrence step, honoring arbitrary unit+interval and the
 * legacy `frequency` enum (quarterly maps to every 3 months). */
export function stepForItem(item: FinancialItem): Step | null {
  const rawInterval =
    item.frequency_interval && item.frequency_interval > 0 ? item.frequency_interval : null;
  if (item.frequency_unit) {
    return { unit: item.frequency_unit as StepUnit, interval: rawInterval ?? 1 };
  }
  // Legacy enum: mirror the backend projection, which uses the enum's own
  // cadence (quarterly = every 3 months) and ignores a stale interval column.
  switch (item.frequency) {
    case "weekly":
      return { unit: "week", interval: 1 };
    case "monthly":
      return { unit: "month", interval: 1 };
    case "quarterly":
      return { unit: "month", interval: 3 };
    case "yearly":
      return { unit: "year", interval: 1 };
    default:
      return null;
  }
}

/** Parse a YYYY-MM-DD string as a LOCAL date (never UTC, so the day never
 * shifts by a timezone). */
export function parseISODate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addStep(date: Date, step: Step): Date {
  const d = new Date(date);
  switch (step.unit) {
    case "day":
      d.setDate(d.getDate() + step.interval);
      break;
    case "week":
      d.setDate(d.getDate() + step.interval * 7);
      break;
    case "month": {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + step.interval);
      // Clamp to the target month's last day (e.g. Jan 31 + 1 month -> Feb 28).
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      break;
    }
    case "year":
      d.setFullYear(d.getFullYear() + step.interval);
      break;
  }
  return d;
}

/** Average amount per month for a recurring item (one-off items contribute 0).
 * Weekly -> x52/12, daily -> x30.44, yearly -> /12. */
export function monthlyEquivalent(item: FinancialItem): number {
  if (item.kind !== "recurring") return 0;
  const amount = parseFloat(item.amount || "0");
  if (!amount) return 0;
  const step = stepForItem(item);
  if (!step) return 0;
  const perUnitToMonthly: Record<StepUnit, number> = {
    day: 30.44,
    week: 52 / 12,
    month: 1,
    year: 1 / 12,
  };
  return (amount * perUnitToMonthly[step.unit]) / step.interval;
}

/** Next occurrence on/after `today`, or null when the item is finished or has
 * no dates. */
export function nextDueDate(item: FinancialItem, today: Date = startOfToday()): Date | null {
  const anchored = parseISODate(item.next_date) ?? parseISODate(item.start_date);
  if (!anchored) return null;
  const step = stepForItem(item);
  if (item.kind !== "recurring" || !step) {
    return anchored >= today ? anchored : null;
  }
  let cursor = new Date(anchored);
  let emitted = 0;
  let guard = 0;
  while (cursor < today && guard++ < 2400) {
    if (item.repeat_count != null && emitted >= item.repeat_count) return null;
    cursor = addStep(cursor, step);
    emitted += 1;
  }
  if (item.repeat_count != null && emitted >= item.repeat_count) return null;
  return cursor;
}

/** Whole days from today to a date (negative = overdue). */
export function daysUntil(date: Date, today: Date = startOfToday()): number {
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
}

/** Estimate when a debt is fully paid at its current periodic payment. */
export function payoffEstimate(
  item: FinancialItem,
  today: Date = startOfToday(),
): { payments: number; date: Date } | null {
  const remaining = parseFloat(item.remaining_balance || item.principal || "0");
  const payment = parseFloat(item.amount || "0");
  if (!(remaining > 0) || !(payment > 0)) return null;
  const step = stepForItem(item) ?? { unit: "month" as StepUnit, interval: 1 };
  const payments = Math.ceil(remaining / payment);
  let date = new Date(today);
  for (let i = 0; i < payments; i += 1) date = addStep(date, step);
  return { payments, date };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatShortDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function formatShortDateYear(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
