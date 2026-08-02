import { describe, it, expect } from "vitest";
import { toRRule, describeRule, weekdayCode, dailyWeeklyMonthlyYearly, recurrencePresetLabel, ordinal } from "./recurrence";

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
