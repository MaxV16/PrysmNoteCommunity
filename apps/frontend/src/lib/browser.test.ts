import { describe, it, expect } from "vitest";
import { detectOS } from "./browser";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};

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
