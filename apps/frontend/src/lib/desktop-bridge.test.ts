import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DESKTOP_TITLEBAR_HEIGHT,
  desktopTitlebarHeight,
  hasWindowControlsOverlay,
  minOverlayTop,
  openDesktopIntegrationConnect,
  openDesktopNotification,
} from "./desktop-bridge";

afterEach(() => {
  document.body.className = "";
  vi.unstubAllGlobals();
});

describe("desktop shell overlay offsets", () => {
  it("uses the caller fallback in the browser", () => {
    expect(desktopTitlebarHeight()).toBe(0);
    expect(minOverlayTop(12)).toBe(12);
    expect(minOverlayTop()).toBe(8);
  });

  it("keeps overlays below the window controls in the desktop shell", () => {
    document.body.classList.add("desktop-shell");
    expect(desktopTitlebarHeight()).toBe(DESKTOP_TITLEBAR_HEIGHT);
    // 38px strip + the caller's own minimum, so a popover/tooltip can never sit
    // on top of the macOS traffic lights or the Windows/Linux button cluster.
    expect(minOverlayTop(12)).toBe(DESKTOP_TITLEBAR_HEIGHT + 12);
  });
});

describe("window controls detection", () => {
  it("ignores a windowControlsOverlay stub without a usable titlebar rect", () => {
    // Brave defines `navigator.windowControlsOverlay` on every page with no
    // methods, so a presence check would wrongly claim native buttons exist.
    vi.stubGlobal("navigator", { windowControlsOverlay: {} });
    const real = window.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element) => {
      const style = real(el);
      return { ...style, width: "0px" };
    });
    expect(hasWindowControlsOverlay()).toBe(false);
  });

  it("reports native controls when the overlay API returns a real rect", () => {
    vi.stubGlobal("navigator", {
      windowControlsOverlay: { getTitlebarAreaRect: () => ({ width: 1180 }) },
    });
    expect(hasWindowControlsOverlay()).toBe(true);
  });

  it("reports frameless when neither the API nor the env vars are there", () => {
    // A desktop build older than the native titlebar change: no WCO API and
    // `env(titlebar-area-width, 0px)` stays at its fallback, so the renderer
    // must draw its own buttons (regression: the live renderer used to draw
    // none, leaving a frameless window with no minimize/maximize/close).
    vi.stubGlobal("navigator", {});
    const real = window.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element) => {
      const style = real(el);
      return { ...style, width: "0px" };
    });
    expect(hasWindowControlsOverlay()).toBe(false);
  });

  it("falls back to the env var probe when the overlay API is missing", () => {
    vi.stubGlobal("navigator", {});
    const real = window.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element) => {
      const style = real(el);
      return { ...style, width: "1200px" };
    });
    expect(hasWindowControlsOverlay()).toBe(true);
  });
});

describe("integration connect hand-off", () => {
  it("is a no-op in the browser so the normal redirect runs", async () => {
    expect(await openDesktopIntegrationConnect("slack", "https://prysmnote.com/settings")).toBe(false);
  });

  it("hands the app settings url to the desktop shell", async () => {
    const startIntegrationConnect = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("prysmDesktop", { isDesktop: true, startIntegrationConnect });
    expect(
      await openDesktopIntegrationConnect("slack", "https://prysmnote.com/settings?tab=integrations")
    ).toBe(true);
    expect(startIntegrationConnect).toHaveBeenCalledWith(
      "slack",
      "https://prysmnote.com/settings?tab=integrations"
    );
  });

  it("returns false when the shell rejects so the caller can fall back", async () => {
    const startIntegrationConnect = vi.fn().mockRejectedValue(new Error("no bridge"));
    vi.stubGlobal("prysmDesktop", { isDesktop: true, startIntegrationConnect });
    expect(
      await openDesktopIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations")
    ).toBe(false);
  });
});

describe("desktop notification hand-off", () => {
  it("is a no-op in the browser", () => {
    expect(openDesktopNotification({ title: "Prysm Note" })).toBe(false);
  });

  it("hands the notification to the desktop shell", () => {
    const showNotification = vi.fn();
    vi.stubGlobal("prysmDesktop", { isDesktop: true, showNotification });
    expect(openDesktopNotification({ title: "Prysm Note", body: "2 tasks due soon" })).toBe(true);
    expect(showNotification).toHaveBeenCalledWith({ title: "Prysm Note", body: "2 tasks due soon" });
  });

  it("returns false when the shell has no notification support", () => {
    vi.stubGlobal("prysmDesktop", { isDesktop: true });
    expect(openDesktopNotification({ title: "Prysm Note" })).toBe(false);
  });
});
