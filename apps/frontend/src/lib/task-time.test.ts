import { describe, it, expect } from "vitest";
import { formatTime12, taskTimeLabel } from "./task-time";

describe("formatTime12", () => {
  it("formats 24h HH:MM into a 12-hour label", () => {
    expect(formatTime12("00:00")).toBe("12:00 AM");
    expect(formatTime12("09:00")).toBe("9:00 AM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
    expect(formatTime12("14:00")).toBe("2:00 PM");
    expect(formatTime12("23:59")).toBe("11:59 PM");
  });

  it("accepts HH:MM:SS with seconds ignored", () => {
    expect(formatTime12("14:05:30")).toBe("2:05 PM");
  });

  it("returns null for empty/garbage input", () => {
    expect(formatTime12(null)).toBeNull();
    expect(formatTime12("")).toBeNull();
    expect(formatTime12("not-a-time")).toBeNull();
  });
});

describe("taskTimeLabel", () => {
  it("shows just the start time when there is no end time", () => {
    const task = { start_time: "14:00", end_time: null, is_all_day: false };
    expect(taskTimeLabel(task)).toBe("2:00 PM");
  });

  it("shows a range when end time is present", () => {
    const task = { start_time: "09:00", end_time: "17:00", is_all_day: false };
    expect(taskTimeLabel(task)).toBe("9:00 AM - 5:00 PM");
  });

  it("is null for all-day tasks and tasks without a time", () => {
    expect(taskTimeLabel({ start_time: "09:00", end_time: null, is_all_day: true })).toBeNull();
    expect(taskTimeLabel({ start_time: null, end_time: null, is_all_day: false })).toBeNull();
  });
});