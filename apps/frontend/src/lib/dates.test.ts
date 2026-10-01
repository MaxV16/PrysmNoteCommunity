import { describe, it, expect, beforeEach, vi } from "vitest";
import { formatDate, formatTime, getDatePrefs, invalidateDatePrefs } from "./dates";

// dates.ts imports the preferences cache (which imports the api client). Mock
// the api so importing this module never touches the network stack.
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));

describe("date preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateDatePrefs();
  });

  it("reads a JSON-encoded timezone instead of deleting it", () => {
    // The settings page writes values with JSON.stringify (quotes included).
    localStorage.setItem("prysm_tz", JSON.stringify("Europe/Berlin"));
    const prefs = getDatePrefs();
    expect(prefs.timeZone).toBe("Europe/Berlin");
    // The setting must survive (the old bug removed it after a failed Intl call).
    expect(localStorage.getItem("prysm_tz")).not.toBeNull();
  });

  it("still reads a legacy raw (unencoded) timezone", () => {
    localStorage.setItem("prysm_tz", "America/New_York");
    invalidateDatePrefs();
    expect(getDatePrefs().timeZone).toBe("America/New_York");
  });

  it("ignores an invalid timezone without throwing", () => {
    localStorage.setItem("prysm_tz", JSON.stringify("Not/AZone"));
    invalidateDatePrefs();
    expect(getDatePrefs().timeZone).toBeUndefined();
  });

  it("falls back to the server-hydrated preference cache", () => {
    localStorage.setItem("prysm_preferences", JSON.stringify({ prysm_tz: "Asia/Tokyo" }));
    invalidateDatePrefs();
    expect(getDatePrefs().timeZone).toBe("Asia/Tokyo");
  });
});

describe("formatDate", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateDatePrefs();
  });

  it("renders a YYYY-MM-DD calendar date literally, never timezone-shifted", () => {
    // Even with a far-west timezone, a calendar date must not roll back a day.
    localStorage.setItem("prysm_tz", JSON.stringify("America/Los_Angeles"));
    localStorage.setItem("prysm_date_format", JSON.stringify("dd/mm/yyyy"));
    invalidateDatePrefs();
    expect(formatDate("2026-09-12")).toBe("12/09/2026");
    expect(formatDate("2026-09-12", { includeYear: false })).toBe("12/09");
  });

  it("honours the configured date format", () => {
    localStorage.setItem("prysm_date_format", JSON.stringify("yyyy-mm-dd"));
    invalidateDatePrefs();
    expect(formatDate("2026-01-05")).toBe("2026-01-05");
    localStorage.setItem("prysm_date_format", JSON.stringify("mm/dd/yyyy"));
    invalidateDatePrefs();
    expect(formatDate("2026-01-05")).toBe("01/05/2026");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDate("not-a-date")).toBe("");
  });
});

describe("formatTime", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateDatePrefs();
  });

  it("formats using the 24h preference", () => {
    localStorage.setItem("prysm_time_format", JSON.stringify("24h"));
    invalidateDatePrefs();
    // A fixed instant formatted in UTC.
    localStorage.setItem("prysm_tz", JSON.stringify("UTC"));
    invalidateDatePrefs();
    expect(formatTime("2026-09-12T14:05:00Z")).toBe("14:05");
  });
});
