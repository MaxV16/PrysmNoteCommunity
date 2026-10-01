import { afterEach, describe, expect, it, vi } from "vitest";
import { celebrate } from "./celebrate";

function stubMatchMedia(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function stubCanvasContext() {
  const ctx = {
    scale: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
  };
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

describe("celebrate", () => {
  afterEach(() => {
    document.querySelectorAll("canvas").forEach((c) => c.remove());
    vi.restoreAllMocks();
  });

  it("does nothing when the user prefers reduced motion", () => {
    const restore = stubMatchMedia(true);
    stubCanvasContext();
    celebrate();
    expect(document.querySelectorAll("canvas").length).toBe(0);
    restore();
  });

  it("appends a short-lived, non-interactive confetti canvas", () => {
    const restore = stubMatchMedia(false);
    const ctx = stubCanvasContext();
    celebrate({ x: 10, y: 20 });
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.style.pointerEvents).toBe("none");
    expect(ctx).toHaveBeenCalled();
    restore();
  });
});
