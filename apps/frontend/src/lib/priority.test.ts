import { describe, it, expect } from "vitest";
import { normalizePriority, TIER_COLORS, TIER_LABELS } from "./priority";

describe("normalizePriority", () => {
  it("keeps canonical 1-3 tier values", () => {
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(2)).toBe(2);
    expect(normalizePriority(3)).toBe(3);
  });

  it("folds legacy out-of-range values to low (3)", () => {
    expect(normalizePriority(4)).toBe(3);
    expect(normalizePriority(5)).toBe(3);
  });

  it("defaults falsy values to medium (2)", () => {
    expect(normalizePriority(undefined)).toBe(2);
    expect(normalizePriority(null)).toBe(2);
    expect(normalizePriority(0)).toBe(2);
  });
});

describe("priority tiers", () => {
  it("maps tier colors: high=red, medium=blue, low=green", () => {
    expect(TIER_COLORS[1]).toBe("#ef5350");
    expect(TIER_COLORS[2]).toBe("#4fc3f7");
    expect(TIER_COLORS[3]).toBe("#66bb6a");
  });

  it("labels the three tiers", () => {
    expect(TIER_LABELS[1]).toBe("High");
    expect(TIER_LABELS[2]).toBe("Medium");
    expect(TIER_LABELS[3]).toBe("Low");
  });
});
