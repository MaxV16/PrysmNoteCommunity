import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_RESIZE_MIN_VIEWPORT,
  clampPanelWidth,
  panelResizePlatform,
  panelStorageKey,
  readStoredPanelWidth,
} from "./use-resizable-panel";

describe("resizable panel helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as unknown as { prysmDesktop?: unknown }).prysmDesktop;
  });

  afterEach(() => {
    delete (window as unknown as { prysmDesktop?: unknown }).prysmDesktop;
  });

  it("clamps widths to the panel bounds", () => {
    expect(clampPanelWidth(100, 180, 360, 1280)).toBe(180);
    expect(clampPanelWidth(500, 180, 360, 1280)).toBe(360);
    expect(clampPanelWidth(240, 180, 360, 1280)).toBe(240);
  });

  it("reserves room for the main content on narrow desktops", () => {
    expect(clampPanelWidth(700, 280, 760, 720)).toBe(400);
    expect(clampPanelWidth(700, 280, 760, PANEL_RESIZE_MIN_VIEWPORT)).toBe(320);
  });

  it("reads a stored width rounded and clamped", () => {
    window.localStorage.setItem("panel", "333.6");
    expect(readStoredPanelWidth("panel", 400, 320, 760, 1280)).toBe(334);

    window.localStorage.setItem("panel", "900");
    expect(readStoredPanelWidth("panel", 400, 320, 760, 1280)).toBe(760);

    window.localStorage.setItem("panel", "not-a-number");
    expect(readStoredPanelWidth("panel", 400, 320, 760, 1280)).toBe(400);
  });

  it("namespaces widths by platform and optional task id", () => {
    expect(panelResizePlatform()).toBe("web");
    expect(panelStorageKey("task", "t1")).toBe(
      "prysm_panel_width:web:task:t1"
    );

    Object.defineProperty(window, "prysmDesktop", {
      configurable: true,
      value: { isDesktop: true, platform: "darwin" },
    });

    expect(panelResizePlatform()).toBe("darwin");
    expect(panelStorageKey("ai")).toBe("prysm_panel_width:darwin:ai");
    expect(panelStorageKey("task", "t1")).toBe(
      "prysm_panel_width:darwin:task:t1"
    );
  });
});
