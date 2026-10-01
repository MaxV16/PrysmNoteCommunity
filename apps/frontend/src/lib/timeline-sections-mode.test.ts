import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sectionsModeFromPrefs,
  sectionsPrefsFromMode,
  persistSectionsMode,
  resolveInitialSectionsMode,
  SECTIONS_HIDDEN_KEY,
  SECTIONS_RAIL_KEY,
  type TimelineSectionsMode,
} from "./timeline-sections-mode";

const ALL_MODES: TimelineSectionsMode[] = ["expanded", "rail"];

describe("timeline sections mode helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("derives the two states from the persisted booleans", () => {
    expect(sectionsModeFromPrefs({ hidden: false, rail: false })).toBe("expanded");
    expect(sectionsModeFromPrefs({ hidden: false, rail: true })).toBe("rail");
    // A legacy fully-hidden preference migrates onto the rail, never strands.
    expect(sectionsModeFromPrefs({ hidden: true, rail: false })).toBe("rail");
    expect(sectionsModeFromPrefs({ hidden: true, rail: true })).toBe("rail");
  });

  it("maps each mode to exactly one true boolean (round-trips)", () => {
    for (const mode of ALL_MODES) {
      const prefs = sectionsPrefsFromMode(mode);
      expect(prefs.hidden).toBe(false);
      expect(prefs.rail).toBe(mode === "rail");
      expect(sectionsModeFromPrefs(prefs)).toBe(mode);
    }
  });

  it("persists the rail key and clears the legacy hidden key", () => {
    persistSectionsMode("rail");
    expect(window.localStorage.getItem(SECTIONS_HIDDEN_KEY)).toBe("0");
    expect(window.localStorage.getItem(SECTIONS_RAIL_KEY)).toBe("1");

    persistSectionsMode("expanded");
    expect(window.localStorage.getItem(SECTIONS_HIDDEN_KEY)).toBe("0");
    expect(window.localStorage.getItem(SECTIONS_RAIL_KEY)).toBe("0");
  });

  it("resolves stored prefs", () => {
    window.localStorage.setItem(SECTIONS_RAIL_KEY, "1");
    expect(resolveInitialSectionsMode()).toBe("rail");

    window.localStorage.setItem(SECTIONS_RAIL_KEY, "0");
    expect(resolveInitialSectionsMode()).toBe("expanded");

    // Legacy hidden migrates to the rail.
    window.localStorage.setItem(SECTIONS_HIDDEN_KEY, "1");
    window.localStorage.setItem(SECTIONS_RAIL_KEY, "0");
    expect(resolveInitialSectionsMode()).toBe("rail");
  });

  describe("phone default", () => {
    const original = window.matchMedia;
    afterEach(() => {
      window.matchMedia = original;
    });

    it("defaults to the rail on a phone when nothing is stored", () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
      expect(resolveInitialSectionsMode()).toBe("rail");
    });

    it("defaults to expanded on desktop when nothing is stored", () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
      expect(resolveInitialSectionsMode()).toBe("expanded");
    });

    it("keeps an explicitly stored expanded choice over the phone default", () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
      window.localStorage.setItem(SECTIONS_RAIL_KEY, "0");
      expect(resolveInitialSectionsMode()).toBe("expanded");
    });
  });
});
