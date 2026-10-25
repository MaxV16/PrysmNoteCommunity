import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_ZOOM_LEVELS,
  CALENDAR_ZOOM_LEVELS,
  TIMELINE_ZOOM_LEVELS,
  ZOOM_STORAGE_PREFIX,
  normalizeZoomLevel,
  readStoredZoom,
  scaledPx,
  stepZoom,
  writeStoredZoom,
  zoomPercent,
  zoomStorageKey,
} from "./view-zoom";

const LEVELS = [0.5, 1, 2] as const;

describe("normalizeZoomLevel", () => {
  it("returns the fallback for null, empty and unparseable input", () => {
    expect(normalizeZoomLevel(null, LEVELS, 1)).toBe(1);
    expect(normalizeZoomLevel("", LEVELS, 1)).toBe(1);
    expect(normalizeZoomLevel("not-a-number", LEVELS, 1)).toBe(1);
    expect(normalizeZoomLevel(Number.NaN, LEVELS, 1)).toBe(1);
    expect(normalizeZoomLevel(Infinity, LEVELS, 1)).toBe(1);
  });

  it("snaps a value between steps to the nearest real step", () => {
    expect(normalizeZoomLevel(0.7, LEVELS, 1)).toBe(0.5);
    expect(normalizeZoomLevel(1.6, LEVELS, 1)).toBe(2);
    expect(normalizeZoomLevel(0.9, LEVELS, 1)).toBe(1);
  });

  it("clamps values outside the ladder to its ends", () => {
    expect(normalizeZoomLevel(-4, LEVELS, 1)).toBe(0.5);
    expect(normalizeZoomLevel(99, LEVELS, 1)).toBe(2);
  });

  it("round-trips strings, which is what localStorage returns", () => {
    expect(normalizeZoomLevel("1.25", TIMELINE_ZOOM_LEVELS, 1)).toBe(1.25);
  });

  it("falls back to 1 for an empty ladder", () => {
    expect(normalizeZoomLevel(2, [], 1)).toBe(1);
  });

  it("keeps every shipped ladder sorted and positive", () => {
    for (const ladder of [TIMELINE_ZOOM_LEVELS, CALENDAR_ZOOM_LEVELS, BOARD_ZOOM_LEVELS]) {
      expect(ladder.length).toBeGreaterThan(1);
      for (let i = 0; i < ladder.length; i++) {
        expect(ladder[i]).toBeGreaterThan(0);
        if (i > 0) expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
      }
      expect(ladder).toContain(1);
    }
    expect(TIMELINE_ZOOM_LEVELS[0]).toBeLessThan(1);
    expect(TIMELINE_ZOOM_LEVELS[TIMELINE_ZOOM_LEVELS.length - 1]).toBeGreaterThan(3);
  });
});

describe("zoom storage", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("namespaces every view under the shared prefix", () => {
    expect(zoomStorageKey("timeline")).toBe(`${ZOOM_STORAGE_PREFIX}timeline`);
    expect(zoomStorageKey("calendar")).toBe("prysm-zoom-calendar");
  });

  it("writes and reads back the chosen step", () => {
    writeStoredZoom("timeline", 2.5);
    expect(readStoredZoom("timeline", TIMELINE_ZOOM_LEVELS, 1)).toBe(2.5);
    expect(localStorage.getItem("prysm-zoom-timeline")).toBe("2.5");
  });

  it("sanitizes corrupt or legacy stored values instead of trusting them", () => {
    localStorage.setItem("prysm-zoom-timeline", "garbage");
    expect(readStoredZoom("timeline", TIMELINE_ZOOM_LEVELS, 1)).toBe(1);

    localStorage.setItem("prysm-zoom-timeline", "-100");
    expect(readStoredZoom("timeline", TIMELINE_ZOOM_LEVELS, 1)).toBe(0.5);

    localStorage.setItem("prysm-zoom-timeline", "1.9");
    expect(readStoredZoom("timeline", TIMELINE_ZOOM_LEVELS, 1)).toBe(2);
  });

  it("returns the fallback when nothing is stored", () => {
    expect(readStoredZoom("board", BOARD_ZOOM_LEVELS, 1)).toBe(1);
    expect(readStoredZoom("kanban", BOARD_ZOOM_LEVELS, 1)).toBe(1);
  });
});

describe("stepZoom", () => {
  it("walks the ladder one step at a time", () => {
    expect(stepZoom(1, LEVELS, 1)).toBe(2);
    expect(stepZoom(1, LEVELS, -1)).toBe(0.5);
    expect(stepZoom(0.5, LEVELS, -1)).toBe(0.5);
    expect(stepZoom(2, LEVELS, 1)).toBe(2);
  });

  it("normalizes an off-ladder current value before stepping", () => {
    expect(stepZoom(0.9, LEVELS, 1)).toBe(2);
    // 1.4 snaps to 1 before stepping down.
    expect(stepZoom(1.4, LEVELS, -1)).toBe(0.5);
  });

  it("returns 1 for an empty ladder", () => {
    expect(stepZoom(2, [], 1)).toBe(1);
  });
});

describe("zoomPercent", () => {
  it("labels ladder steps as whole percentages", () => {
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(0.5)).toBe("50%");
    expect(zoomPercent(1.25)).toBe("125%");
    expect(zoomPercent(6)).toBe("600%");
  });

  it("never renders NaN for a broken value", () => {
    expect(zoomPercent(Number.NaN)).toBe("100%");
  });
});

describe("scaledPx", () => {
  it("scales a base size by the zoom", () => {
    expect(scaledPx(280, 1, 220, 420)).toBe(280);
    expect(scaledPx(280, 1.5, 220, 420)).toBe(420);
    expect(scaledPx(280, 0.75, 220, 420)).toBe(220);
  });

  it("clamps both directions so a column can never collapse or overflow", () => {
    expect(scaledPx(280, 0.1, 220, 420)).toBe(220);
    expect(scaledPx(280, 100, 220, 420)).toBe(420);
  });

  it("treats a broken zoom as 100%", () => {
    expect(scaledPx(280, Number.NaN, 220, 420)).toBe(280);
    expect(scaledPx(280, Infinity, 220, 420)).toBe(280);
  });
});
