import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  MAX_THEME_DOC_LENGTH,
  MAX_THEME_KEYS,
  computeVarChanges,
  describeTheme,
  isSafeThemeValue,
  parseThemeDocument,
  serializeThemeDocument,
  themeColorsToVars,
  type ImportedTheme,
} from "@/lib/theme-import";

const validDoc = {
  format: "prysm-theme",
  formatVersion: 1,
  name: "Deep Ocean",
  author: "Prysm",
  version: "1.0",
  vars: {
    "--accent": "#5AA9FF",
    "--bg-base": "#05070d",
    "--bg-surface": "rgb(10, 14, 24)",
    "--shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
    "--grad-from": "color-mix(in srgb, #5AA9FF 60%, transparent)",
  },
};

describe("parseThemeDocument", () => {
  it("accepts a valid document and keeps metadata out of the vars", () => {
    const result = parseThemeDocument(JSON.stringify(validDoc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.name).toBe("Deep Ocean");
    expect(result.theme.author).toBe("Prysm");
    expect(result.theme.version).toBe("1.0");
    expect(result.theme.vars["--accent"]).toBe("#5AA9FF");
    expect(result.theme.vars["--shadow-sm"]).toBe("0 2px 8px rgba(0,0,0,0.5)");
    expect(result.theme.vars).not.toHaveProperty("name");
  });

  it("tolerates surrounding whitespace and a bare token map", () => {
    const result = parseThemeDocument('  \n { "--accent": "#fff", "--radius-sm": "8px" } \n ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.vars).toEqual({ "--accent": "#fff", "--radius-sm": "8px" });
  });

  it("rejects non-object and non-JSON payloads", () => {
    for (const text of ["", "   ", "not json", "[1,2,3]", "null", '"dark"', "42"]) {
      const result = parseThemeDocument(text);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an oversized file before parsing", () => {
    const result = parseThemeDocument("a".repeat(MAX_THEME_DOC_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("too large");
  });

  it("rejects unknown tokens and lists them instead of dropping them", () => {
    const result = parseThemeDocument(
      JSON.stringify({ vars: { "--accent": "#fff", "--evil-token": "1px", "--other": "red" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.join(" ");
    expect(message).toContain("--evil-token");
    expect(message).toContain("--other");
  });

  it("rejects layout-only tokens", () => {
    const result = parseThemeDocument(JSON.stringify({ vars: { "--ui-scale": "0.5" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("--ui-scale");
  });

  it("rejects a document with too many keys", () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < MAX_THEME_KEYS + 1; i += 1) vars[`--unknown-${i}`] = "1px";
    const result = parseThemeDocument(JSON.stringify({ vars }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("too many variables");
  });

  it("rejects unknown top-level fields in the wrapped shape", () => {
    const result = parseThemeDocument(
      JSON.stringify({ vars: { "--accent": "#fff" }, color: "red" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain('"color"');
  });

  it("strips angle brackets and control characters from display metadata", () => {    const result = parseThemeDocument(
      JSON.stringify({ vars: { "--accent": "#fff" }, name: "A <b>name</b>\u0007" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.name).not.toContain("<");
    expect(result.theme.name).not.toContain(">");
  });
});

describe("shipped example theme", () => {
  it("parses cleanly so users can always start from it", () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, "../../public/themes/example.json"),
      "utf8",
    );
    const result = parseThemeDocument(raw);
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.theme.name).toBe("Deep Ocean");
    expect(result.theme.vars["--accent"]).toBe("#5AA9FF");
    expect(Object.keys(result.theme.vars).length).toBeGreaterThan(10);
  });
});

describe("CSS value safety", () => {
  it("accepts the supported color, length and shadow grammar", () => {
    for (const value of [
      "#fff",
      "#0F0C15",
      "rgba(0, 0, 0, 0.5)",
      "hsl(240 100% 98%)",
      "oklch(0.7 0.1 250 / 50%)",
      "color-mix(in srgb, #5AA9FF 60%, transparent)",
      "0 2px 8px rgba(0,0,0,0.5)",
      "0 0 20px var(--accent-glow)",
      "cubic-bezier(0.34, 1.56, 0.64, 1)",
      "linear-gradient(135deg, #0f0c29, #302b63)",
      "1.1",
      "12px",
      "block",
      "transparent",
      "currentColor",
    ]) {
      expect(isSafeThemeValue(value), value).toBe(true);
    }
  });

  it("rejects injection and breakout payloads", () => {
    for (const value of [
      "url(https://evil.example/track.png)",
      "url(javascript:alert(1))",
      "red; } body { display: none",
      "red } .x { color: blue",
      "expression(alert(1))",
      "javascript:alert(1)",
      "@import url(https://evil.example/x.css)",
      "<svg onload=alert(1)>",
      "red\\; background: url(x)",
      "image-set(url(x) 1x)",
      "attr(data-x)",
      "0 2px 8px\u0000",
      "#fff !important",
    ]) {
      expect(isSafeThemeValue(value), value).toBe(false);
    }
  });

  it("rejects unsafe values through the parser with the token named", () => {
    const result = parseThemeDocument(
      JSON.stringify({ vars: { "--accent": "#fff", "--bg-base": "url(https://x.test/a.png)" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.join(" ");
    expect(message).toContain("--bg-base");
    expect(message).toContain("url(");
  });

  it("rejects non-string values", () => {
    const result = parseThemeDocument(JSON.stringify({ vars: { "--accent": 42 } }));
    expect(result.ok).toBe(false);
  });
});

describe("serializeThemeDocument", () => {
  const theme: ImportedTheme = {
    name: "Round Trip",
    author: "Tester",
    version: "2",
    vars: {
      "--accent": "#5AA9FF",
      "--bg-base": "#05070d",
      "--shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
    },
  };

  it("round-trips export -> import exactly", () => {
    const parsed = parseThemeDocument(serializeThemeDocument(theme));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme).toEqual(theme);
  });

  it("is deterministic", () => {
    const reordered: ImportedTheme = {
      ...theme,
      vars: {
        "--shadow-sm": theme.vars["--shadow-sm"],
        "--bg-base": theme.vars["--bg-base"],
        "--accent": theme.vars["--accent"],
      },
    };
    expect(serializeThemeDocument(reordered)).toBe(serializeThemeDocument(theme));
  });
});

describe("applied token set", () => {
  it("never applies an unknown token", () => {
    const previous = new Set<string>();
    const changes = computeVarChanges(previous, { "--accent": "#fff", "--nope": "1px" });
    expect(changes.set).toEqual([["--accent", "#fff"]]);
    expect(changes.remove).toEqual([]);
  });

  it("removes every previously applied token when switching to a built-in theme", () => {
    const previous = new Set(["--accent", "--bg-base", "--shadow-sm"]);
    const changes = computeVarChanges(previous, undefined);
    expect(changes.set).toEqual([]);
    expect(changes.remove.sort()).toEqual(["--accent", "--bg-base", "--shadow-sm"]);
  });

  it("removes only the tokens the next theme drops", () => {
    const previous = new Set(["--accent", "--bg-base"]);
    const changes = computeVarChanges(previous, { "--accent": "#111" });
    expect(changes.set).toEqual([["--accent", "#111"]]);
    expect(changes.remove).toEqual(["--bg-base"]);
  });
});

describe("describeTheme + themeColorsToVars", () => {
  it("describes counts and up to six swatches, priority first", () => {
    const description = describeTheme({
      name: "Preview",
      vars: {
        "--text-muted": "#888888",
        "--border": "#333333",
        "--bg-base": "#05070d",
        "--accent": "#5AA9FF",
        "--bg-surface": "#0a0e18",
        "--bg-elevated": "#111827",
        "--text-primary": "#f5f5ff",
        "--radius-sm": "8px",
      },
    });
    expect(description.name).toBe("Preview");
    expect(description.count).toBe(8);
    expect(description.swatches).toEqual([
      "#5AA9FF",
      "#05070d",
      "#0a0e18",
      "#111827",
      "#f5f5ff",
      "#333333",
    ]);
  });

  it("maps the built-in palette shape onto token names", () => {
    const vars = themeColorsToVars({
      base: "#07070b",
      accent: "#6c5ce7",
      "shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
      label: "ignored",
      extra: {},
    });
    expect(vars["--bg-base"]).toBe("#07070b");
    expect(vars["--accent"]).toBe("#6c5ce7");
    expect(vars["--shadow-sm"]).toBe("0 2px 8px rgba(0,0,0,0.5)");
    expect(Object.keys(vars)).toHaveLength(3);
  });
});
