import { describe, expect, it } from "vitest";
import {
  DAY_WIDTH,
  PHONE_BREAKPOINT,
  PHONE_DAY_WIDTH_MIN,
  responsiveDayWidth,
} from "./constants";

describe("responsiveDayWidth", () => {
  it("keeps the full desktop column at and above the phone breakpoint", () => {
    for (const vw of [PHONE_BREAKPOINT, 1024, 1280, 1440, 2560]) {
      expect(responsiveDayWidth(vw)).toBe(DAY_WIDTH);
    }
  });

  it("never shrinks a phone column below the readable minimum", () => {
    for (const vw of [320, 360, 375, 390, 412, 430, 767]) {
      expect(responsiveDayWidth(vw)).toBeGreaterThanOrEqual(PHONE_DAY_WIDTH_MIN);
      expect(responsiveDayWidth(vw)).toBeLessThanOrEqual(DAY_WIDTH);
    }
  });

  it("gives a phone a wider column than the old 56px clamp", () => {
    // The old formula was clamp(56, vw * 0.15, 120); at 412px it produced 62px,
    // which clipped every bar label to a few characters.
    expect(responsiveDayWidth(412)).toBeGreaterThan(88);
  });

  it("grows smoothly with the viewport inside the phone range", () => {
    const narrow = responsiveDayWidth(375);
    const wide = responsiveDayWidth(430);
    expect(wide).toBeGreaterThan(narrow);
  });
});
