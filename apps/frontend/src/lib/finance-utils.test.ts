import { describe, it, expect } from "vitest";
import {
  monthlyEquivalent,
  nextDueDate,
  payoffEstimate,
  stepForItem,
  daysUntil,
} from "./finance-utils";
import type { FinancialItem } from "@/hooks/useFinance";

function item(overrides: Partial<FinancialItem> = {}): FinancialItem {
  return {
    id: "i1",
    name: "Item",
    direction: "expense",
    amount: "100",
    kind: "recurring",
    start_date: "2026-01-01",
    end_date: null,
    frequency: null,
    next_date: null,
    principal: null,
    remaining_balance: null,
    interest_rate: null,
    paid_off_at: null,
    repeat_count: null,
    frequency_unit: "month",
    frequency_interval: 1,
    ...overrides,
  };
}

describe("monthlyEquivalent", () => {
  it("normalises weekly, monthly and yearly cadences", () => {
    expect(monthlyEquivalent(item({ frequency_unit: "month", frequency_interval: 1 }))).toBeCloseTo(100);
    expect(monthlyEquivalent(item({ frequency_unit: "week", frequency_interval: 1 }))).toBeCloseTo((100 * 52) / 12);
    expect(monthlyEquivalent(item({ frequency_unit: "year", frequency_interval: 1 }))).toBeCloseTo(100 / 12);
    expect(monthlyEquivalent(item({ frequency_unit: "month", frequency_interval: 3 }))).toBeCloseTo(100 / 3);
  });

  it("ignores one-off items", () => {
    expect(monthlyEquivalent(item({ kind: "one_off" }))).toBe(0);
  });

  it("maps the legacy quarterly frequency to every 3 months", () => {
    expect(stepForItem(item({ frequency_unit: null, frequency: "quarterly" }))).toEqual({ unit: "month", interval: 3 });
    expect(monthlyEquivalent(item({ frequency_unit: null, frequency: "quarterly" }))).toBeCloseTo(100 / 3);
  });
});

describe("nextDueDate", () => {
  const today = new Date(2026, 8, 18); // 18 Sep 2026

  it("returns the anchored date when it is still ahead", () => {
    const due = nextDueDate(item({ start_date: "2026-10-01" }), today);
    expect(due && due.getTime()).toBe(new Date(2026, 9, 1).getTime());
  });

  it("rolls a past start forward to the next occurrence", () => {
    const due = nextDueDate(item({ start_date: "2026-01-15", frequency_unit: "month" }), today);
    // 15 Sep is already behind the 18 Sep anchor, so the next one is 15 Oct.
    expect(due && due.getTime()).toBe(new Date(2026, 9, 15).getTime());
  });

  it("returns null once a capped series is finished", () => {
    const due = nextDueDate(
      item({ start_date: "2026-01-15", frequency_unit: "month", repeat_count: 3 }),
      today,
    );
    expect(due).toBeNull();
  });

  it("prefers an explicit next_date anchor", () => {
    const due = nextDueDate(item({ next_date: "2026-09-20" }), today);
    expect(daysUntil(due!, today)).toBe(2);
  });
});

describe("payoffEstimate", () => {
  const today = new Date(2026, 8, 18);

  it("divides the remaining balance by the periodic payment", () => {
    const est = payoffEstimate(
      item({ amount: "250", principal: "3000", remaining_balance: "1000", frequency_unit: "month" }),
      today,
    );
    expect(est?.payments).toBe(4);
    expect(est?.date.getTime()).toBe(new Date(2027, 0, 18).getTime());
  });

  it("returns null when there is no payment or nothing left", () => {
    expect(payoffEstimate(item({ amount: "0", remaining_balance: "500" }), today)).toBeNull();
    expect(payoffEstimate(item({ amount: "100", remaining_balance: "0", principal: "0" }), today)).toBeNull();
  });
});
