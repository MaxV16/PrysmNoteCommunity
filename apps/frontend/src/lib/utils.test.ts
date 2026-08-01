import { describe, it, expect } from "vitest";
import { formatDate, getStatusColor, toLocalDateString, parseLocalDate } from "./utils";

describe("formatDate", () => {
  it("formats a Date object", () => {
    const result = formatDate(new Date("2025-06-15"));
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2025");
  });

  it("formats a date string", () => {
    const result = formatDate("2025-06-15");
    expect(result).toContain("Jun");
    expect(result).toContain("15");
  });

  it("returns NaN date for invalid input", () => {
    const result = formatDate("invalid");
    expect(result).toBe("Invalid Date");
  });
});

describe("getStatusColor", () => {
  it("returns muted for backlog", () => {
    expect(getStatusColor("backlog")).toBe("var(--text-muted)");
  });

  it("returns accent for todo", () => {
    expect(getStatusColor("todo")).toBe("var(--accent)");
  });

  it("returns warning for in_progress", () => {
    expect(getStatusColor("in_progress")).toBe("var(--warning)");
  });

  it("returns success for done", () => {
    expect(getStatusColor("done")).toBe("var(--success)");
  });

  it("returns danger for cancelled", () => {
    expect(getStatusColor("cancelled")).toBe("var(--danger)");
  });

  it("returns secondary for unknown status", () => {
    expect(getStatusColor("unknown")).toBe("var(--text-secondary)");
  });
});

describe("toLocalDateString", () => {
  it("formats a date as YYYY-MM-DD using local date fields", () => {
    expect(toLocalDateString(new Date(2026, 7, 1))).toBe("2026-08-01");
    expect(toLocalDateString(new Date(2026, 11, 31))).toBe("2026-12-31");
    expect(toLocalDateString(new Date(2026, 0, 9))).toBe("2026-01-09");
  });

  it("zero-pads month and day", () => {
    expect(toLocalDateString(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});

describe("parseLocalDate", () => {
  it("parses YYYY-MM-DD as local midnight without UTC shift", () => {
    const d = parseLocalDate("2026-08-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(1);
    // 1 Aug local should line up with the timeline's local day column.
    expect(d.getHours()).toBe(0);
  });

  it("round-trips through toLocalDateString", () => {
    const original = new Date(2026, 7, 1);
    const parsed = parseLocalDate(toLocalDateString(original));
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(1);
  });

  it("returns an invalid date for garbage input", () => {
    expect(Number.isNaN(parseLocalDate("nonsense").getTime())).toBe(true);
  });
});
