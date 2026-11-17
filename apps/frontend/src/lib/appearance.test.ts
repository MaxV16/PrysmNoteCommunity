import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  appearanceVars,
  isSafeImageUrl,
  parseAppearance,
  parseAppearanceJson,
  serialiseAppearance,
  surfaceStyle,
} from "./appearance";

describe("appearance", () => {
  it("falls back to the defaults for a non-object", () => {
    expect(parseAppearance(null).config).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance([]).errors).toHaveLength(1);
  });

  it("applies every valid field", () => {
    const { config, errors } = parseAppearance({
      taskStyle: "outline",
      glass: true,
      board: "aurora",
      countdown: "dots",
      customBoardImage: "https://example.com/bg.jpg",
    });
    expect(errors).toEqual([]);
    expect(config).toEqual({
      taskStyle: "outline",
      glass: true,
      board: "aurora",
      countdown: "dots",
      customBoardImage: "https://example.com/bg.jpg",
    });
  });

  it("accepts an exported document with an appearance wrapper", () => {
    const exported = serialiseAppearance({ ...DEFAULT_APPEARANCE, board: "ocean" });
    expect(parseAppearanceJson(exported).config.board).toBe("ocean");
  });

  it("rejects an unknown task style and keeps the default", () => {
    const { config, errors } = parseAppearance({ taskStyle: "neon" });
    expect(config.taskStyle).toBe("default");
    expect(errors[0]).toContain("Unknown task style");
  });

  it("rejects an unknown surface preset", () => {
    const { config, errors } = parseAppearance({ board: "lava" });
    expect(config.board).toBe("none");
    expect(errors[0]).toContain("Unknown board background");
  });

  it("only accepts plain https image urls", () => {
    expect(isSafeImageUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeImageUrl("http://example.com/a.png")).toBe(false);
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl('https://example.com/a".png')).toBe(false);
    expect(isSafeImageUrl("https://example.com/a(1).png")).toBe(false);
    expect(isSafeImageUrl("")).toBe(false);
  });

  it("requires an image when a surface is custom", () => {
    const { config, errors } = parseAppearance({ board: "custom" });
    expect(config.board).toBe("none");
    expect(errors.some((error) => error.includes("custom board background"))).toBe(true);
  });

  it("builds the custom surface from the image url", () => {
    const style = surfaceStyle("custom", "https://example.com/bg.jpg");
    expect(style.image).toBe('url("https://example.com/bg.jpg")');
    expect(style.size).toBe("cover");
    // An unsafe image falls back to no background instead of leaking into CSS.
    expect(surfaceStyle("custom", "javascript:alert(1)").image).toBe("none");
  });

  it("writes the four surface variables", () => {
    const vars = appearanceVars({
      ...DEFAULT_APPEARANCE,
      board: "grid",
      countdown: "aurora",
      customBoardImage: "https://example.com/bg.jpg",
    });
    expect(Object.keys(vars).sort()).toEqual([
      "--surface-board-image",
      "--surface-board-size",
      "--surface-countdown-image",
      "--surface-countdown-size",
    ]);
    expect(vars["--surface-board-size"]).toBe("28px 28px");
  });
});
