import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectBrowser, detectOS, installGuide, isStandalone, supportsNativePrompt } from "./browser";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneBrave:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidBrave:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidFirefox:
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0",
  androidOpera:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 OPR/80.0.0.0",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidDuckDuckGo:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 DuckDuckGo/5",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};

function mockBrave() {
  Object.defineProperty(navigator, "brave", {
    value: { isBrave: () => Promise.resolve(true) },
    configurable: true,
  });
}

function unmockBrave() {
  Object.defineProperty(navigator, "brave", { value: undefined, configurable: true });
}

describe("detectOS", () => {
  it("detects iPhone and iPad as iOS", () => {
    expect(detectOS(UA.iphoneSafari)).toBe("ios");
    expect(detectOS("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) Safari/604.1")).toBe("ios");
  });

  it("detects Android", () => {
    expect(detectOS(UA.androidChrome)).toBe("android");
  });

  it("detects desktop", () => {
    expect(detectOS(UA.macChrome)).toBe("desktop");
    expect(detectOS(UA.windowsEdge)).toBe("desktop");
  });

  it("treats an iPad masquerading as Mac (multi-touch) as iOS", () => {
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe("ios");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
  });
});

describe("detectBrowser", () => {
  afterEach(() => unmockBrave());

  it("detects Brave via the navigator.brave object", () => {
    mockBrave();
    expect(detectBrowser(UA.androidBrave)).toBe("brave");
    expect(detectBrowser(UA.iphoneBrave)).toBe("brave");
  });

  it("detects Chromium browsers that also contain chrome in the UA", () => {
    unmockBrave();
    expect(detectBrowser(UA.androidEdge)).toBe("edge");
    expect(detectBrowser(UA.windowsEdge)).toBe("edge");
    expect(detectBrowser(UA.androidOpera)).toBe("opera");
    expect(detectBrowser(UA.androidSamsung)).toBe("samsung");
  });

  it("detects Firefox on Android and iOS", () => {
    unmockBrave();
    expect(detectBrowser(UA.androidFirefox)).toBe("firefox");
    expect(detectBrowser(UA.iphoneFirefox)).toBe("firefox");
  });

  it("detects Chrome on Android and iOS", () => {
    unmockBrave();
    expect(detectBrowser(UA.androidChrome)).toBe("chrome");
    expect(detectBrowser(UA.iphoneChrome)).toBe("chrome");
  });

  it("detects Safari, DuckDuckGo and unknown browsers", () => {
    unmockBrave();
    expect(detectBrowser(UA.iphoneSafari)).toBe("safari");
    expect(detectBrowser(UA.androidDuckDuckGo)).toBe("duckduckgo");
    expect(detectBrowser("SomeUnknown/1.0")).toBe("other");
  });
});

describe("isStandalone", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it("is true in standalone display mode", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    expect(isStandalone()).toBe(true);
  });

  it("is true for the iOS navigator.standalone flag", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
  });

  it("is false in a normal browser tab", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    expect(isStandalone()).toBe(false);
  });
});

describe("installGuide", () => {
  it("uses the Share sheet instructions on iOS for every browser", () => {
    for (const browser of ["safari", "chrome", "brave", "firefox", "edge"] as const) {
      const guide = installGuide("ios", browser);
      expect(guide.native).toBe(false);
      const text = guide.steps.join(" ");
      expect(text).toMatch(/Share/i);
      expect(text).toMatch(/Add to Home Screen/i);
    }
  });

  it("marks Chromium Android as native and non-Chromium as manual", () => {
    expect(installGuide("android", "chrome").native).toBe(true);
    expect(installGuide("android", "edge").native).toBe(true);
    expect(installGuide("android", "opera").native).toBe(true);
    expect(installGuide("android", "samsung").native).toBe(true);
    expect(installGuide("android", "brave").native).toBe(false);
    expect(installGuide("android", "firefox").native).toBe(false);
  });

  it("gives browser-specific Android menu steps", () => {
    // Brave's install item is "Install and create shortcut" (older builds show
    // "Add to Home screen"); the guide must also mention the Customize menu.
    const brave = installGuide("android", "brave").steps.join(" ");
    expect(brave).toMatch(/three-dot menu/i);
    expect(brave).toMatch(/Install and create shortcut/i);
    expect(brave).toMatch(/Install app/i);
    expect(brave).toMatch(/Customize menu/i);
    const firefox = installGuide("android", "firefox").steps.join(" ");
    expect(firefox).toMatch(/Add to Home screen/i);
    expect(installGuide("android", "samsung").steps.join(" ")).toMatch(/Home screen/i);
  });

  it("does not offer a native dialog on desktop", () => {
    expect(installGuide("desktop", "chrome").native).toBe(false);
  });
});

describe("supportsNativePrompt", () => {
  it("allows the native prompt only for WebAPK-capable Android browsers", () => {
    expect(supportsNativePrompt("android", "chrome")).toBe(true);
    expect(supportsNativePrompt("android", "edge")).toBe(true);
    expect(supportsNativePrompt("android", "brave")).toBe(false);
    expect(supportsNativePrompt("android", "firefox")).toBe(false);
    expect(supportsNativePrompt("ios", "safari")).toBe(false);
  });

  it("trusts the captured event on desktop", () => {
    expect(supportsNativePrompt("desktop", "chrome")).toBe(true);
  });
});
