import { describe, it, expect } from "vitest";
import { toRRule, describeRule, weekdayCode, dailyWeeklyMonthlyYearly, recurrencePresetLabel, ordinal, stripEnd, applyEnd, parseEnd } from "./recurrence";

describe("recurrence helpers", () => {
  it("toRRule: daily / none", () => {
    expect(toRRule({ type: "none" })).toBe("");
    expect(toRRule({ type: "daily" })).toBe("FREQ=DAILY");
  });

  it("toRRule: weekly with byday", () => {
    expect(toRRule({ type: "weekly", byDay: "TH" })).toBe("FREQ=WEEKLY;BYDAY=TH");
  });

  it("toRRule: monthly by day of month", () => {
    expect(toRRule({ type: "monthly", dayOfMonth: 20 })).toBe("FREQ=MONTHLY;BYMONTHDAY=20");
  });

  it("toRRule: custom with interval and skip-weekends workday", () => {
    const r = toRRule({ type: "custom", freq: "weekly", interval: 2, byDay: "WORKDAY", skipWeekends: true });
    expect(r).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    const monthly = toRRule({ type: "custom", freq: "monthly", interval: 1, dayOfMonth: 20 });
    expect(monthly).toBe("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20");
  });

  it("describeRule: labels common recurrences", () => {
    expect(describeRule("FREQ=DAILY")).toBe("Daily");
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe("Every weekday");
    expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=20")).toBe("Monthly");
    expect(describeRule(null)).toBeNull();
  });

  it("weekdayCode: Thursday is TH", () => {
    expect(weekdayCode(new Date(2026, 7, 20))).toBe("TH");
  });

  it("dailyWeeklyMonthlyYearly: monthly uses the day of the month", () => {
    expect(dailyWeeklyMonthlyYearly(new Date(2026, 7, 20), "monthly")).toBe("FREQ=MONTHLY;BYMONTHDAY=20");
    expect(dailyWeeklyMonthlyYearly(new Date(2026, 7, 20), "weekly")).toBe("FREQ=WEEKLY;BYDAY=TH");
  });
});

describe("recurrence preset labels", () => {
  // 2026-08-20 is a Thursday.
  it("renders descriptive labels from the selected date (not blank)", () => {
    const iso = "2026-08-20";
    expect(recurrencePresetLabel("daily", iso)).toBe("Daily");
    expect(recurrencePresetLabel("weekly", iso)).toBe("Weekly (Thu)");
    expect(recurrencePresetLabel("monthly", iso)).toBe("Monthly (20th)");
    expect(recurrencePresetLabel("yearly", iso)).toBe("Yearly (20 Aug)");
    expect(recurrencePresetLabel("weekday", iso)).toBe("Every Weekday (Mon–Fri)");
  });

  it("applies correct ordinal suffixes", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(20)).toBe("20th");
    expect(ordinal(21)).toBe("21st");
  });
});

describe("recurrence end helpers", () => {
  it("stripEnd removes COUNT and UNTIL clauses", () => {
    expect(stripEnd("FREQ=DAILY;COUNT=3")).toBe("FREQ=DAILY");
    expect(stripEnd("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(stripEnd("FREQ=DAILY;UNTIL=20261231")).toBe("FREQ=DAILY");
    expect(stripEnd("FREQ=DAILY")).toBe("FREQ=DAILY");
    expect(stripEnd("")).toBe("");
  });

  it("applyEnd: never strips end and clears the column", () => {
    expect(applyEnd("FREQ=DAILY;COUNT=5", { kind: "never" })).toEqual({
      recurrence_rule: "FREQ=DAILY",
      recurrence_end_date: null,
    });
  });

  it("applyEnd: date persists to recurrence_end_date, stripped of COUNT", () => {
    expect(applyEnd("FREQ=DAILY;COUNT=5", { kind: "date", date: "2026-12-31" })).toEqual({
      recurrence_rule: "FREQ=DAILY",
      recurrence_end_date: "2026-12-31",
    });
  });

  it("applyEnd: count appends ;COUNT=N and clears the column", () => {
    expect(applyEnd("FREQ=WEEKLY;BYDAY=MO", { kind: "count", count: 12 })).toEqual({
      recurrence_rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12",
      recurrence_end_date: null,
    });
    expect(applyEnd("FREQ=DAILY;COUNT=3", { kind: "count", count: 4 })).toEqual({
      recurrence_rule: "FREQ=DAILY;COUNT=4",
      recurrence_end_date: null,
    });
  });

  it("applyEnd: count clamps to at least 1", () => {
    expect(applyEnd("FREQ=DAILY", { kind: "count", count: 0 }).recurrence_rule).toBe("FREQ=DAILY;COUNT=1");
  });

  it("parseEnd: reads COUNT from the rule first", () => {
    expect(parseEnd("FREQ=DAILY;COUNT=3", "2026-12-31")).toEqual({ kind: "count", count: 3 });
  });

  it("parseEnd: reads UNTIL from the rule (compact 8-digit form)", () => {
    expect(parseEnd("FREQ=DAILY;UNTIL=20261231", null)).toEqual({ kind: "date", date: "2026-12-31" });
  });

  it("parseEnd: falls back to the recurrence_end_date column", () => {
    expect(parseEnd("FREQ=WEEKLY", "2026-12-31")).toEqual({ kind: "date", date: "2026-12-31" });
  });

  it("parseEnd: defaults to never when nothing is set", () => {
    expect(parseEnd(null, null)).toEqual({ kind: "never" });
    expect(parseEnd(undefined, undefined)).toEqual({ kind: "never" });
  });
});
