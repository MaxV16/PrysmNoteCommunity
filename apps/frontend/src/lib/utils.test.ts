import { describe, it, expect } from "vitest";
import { formatDate, getStatusColor } from "./utils";

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
