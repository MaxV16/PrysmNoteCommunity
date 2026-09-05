import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { KNOWN_CSS_VARS, validateCustomTheme, validateCustomThemeError } from "@/lib/theme-vars";

let globalsCss = "";
beforeAll(() => {
  globalsCss = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
});

const VAR_TOKEN = /--[a-z0-9][a-z0-9-]*/gi;

const validTheme = {
  base: "#07070b",
  surface: "#0f0f16",
  elevated: "#181820",
  hover: "#22222e",
  border: "#2a2a3a",
  primary: "#f0f0f4",
  secondary: "#c0c0d0",
  muted: "#9090a8",
  accent: "#6c5ce7",
  "accent-hover": "#7f70f0",
  danger: "#ff4757",
  success: "#2ed573",
  warning: "#ffa502",
  "shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
  "shadow-md": "0 8px 24px rgba(0,0,0,0.6)",
  "shadow-lg": "0 16px 48px rgba(0,0,0,0.7)",
  "accent-glow": "rgba(108,92,231,0.35)",
};

describe("theme-vars allowlist", () => {
  it("covers every custom property used in globals.css", () => {
    const tokens = new Set(globalsCss.match(VAR_TOKEN) ?? []);
    const missing = [...tokens].filter((t) => !KNOWN_CSS_VARS.has(t));
    expect(missing).toEqual([]);
  });
});

describe("validateCustomTheme", () => {
  it("accepts a valid theme and preserves label + extra", () => {
    const theme = validateCustomTheme({ ...validTheme, label: "My Theme", extra: { "--danger-hover": "#ff6b78", "--radius-sm": "12px" } });
    expect(theme).not.toBeNull();
    expect(theme!.label).toBe("My Theme");
    expect(theme!.extra).toEqual({ "--danger-hover": "#ff6b78", "--radius-sm": "12px" });
  });

  it("accepts uppercase hex colors", () => {
    const theme = validateCustomTheme({ ...validTheme, base: "#1F1F1F" });
    expect(theme).not.toBeNull();
    expect(theme!.base).toBe("#1F1F1F");
  });

  it("accepts rgb()/hsl() and rgba() colors", () => {
    const theme = validateCustomTheme({ ...validTheme, accent: "rgb(108, 92, 231)", "accent-glow": "rgba(108,92,231,0.3)", primary: "hsl(240, 100%, 98%)" });
    expect(theme).not.toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateCustomTheme(null)).toBeNull();
    expect(validateCustomTheme("dark")).toBeNull();
    expect(validateCustomTheme([1, 2, 3])).toBeNull();
  });

  it("rejects a missing required key", () => {
    const { accent, ...missingAccent } = validTheme;
    expect(validateCustomTheme(missingAccent)).toBeNull();
    expect(validateCustomThemeError(missingAccent)).toContain("accent");
  });

  it("rejects an unknown extra variable", () => {
    const err = validateCustomThemeError({ ...validTheme, extra: { "--evil-payload": "url(javascript:alert(1))" } });
    expect(err).toContain("--evil-payload");
    expect(validateCustomTheme({ ...validTheme, extra: { "--evil-payload": "x" } })).toBeNull();
  });

  it("rejects extra values that can smuggle CSS", () => {
    const theme = { ...validTheme, extra: { "--danger-hover": "red; } body { display: none", "--radius-sm": "14px" } };
    expect(validateCustomThemeError(theme)).toContain("--danger-hover");
    expect(validateCustomTheme(theme)).toBeNull();
  });

  it("rejects a shadow with a semicolon", () => {
    const err = validateCustomThemeError({ ...validTheme, "shadow-sm": "0 2px 8px; color: red" });
    expect(err).toContain("shadow-sm");
  });

  it("accepts extra with every allowlisted variable", () => {
    const extra: Record<string, string> = {};
    for (const name of KNOWN_CSS_VARS) extra[name] = "#123456";
    const theme = validateCustomTheme({ ...validTheme, extra });
    expect(theme).not.toBeNull();
    expect(Object.keys(theme!.extra ?? {})).toHaveLength(KNOWN_CSS_VARS.size);
  });

  it("sanitizes an unsafe label", () => {
    const theme = validateCustomTheme({ ...validTheme, label: "My <script> Theme!" });
    expect(theme!.label).not.toContain("<");
    expect(theme!.label).not.toContain(">");
    expect(theme!.label!.length).toBeLessThanOrEqual(60);
  });

  it("round-trips export -> import including extra", () => {
    const first = validateCustomTheme({ ...validTheme, label: "Nord-ish", extra: { "--shadow-glow": "0 0 20px var(--accent-glow)" } })!;
    const exported = JSON.parse(JSON.stringify({ ...first, label: first.label, extra: first.extra }));
    const second = validateCustomTheme(exported);
    expect(second).toEqual(first);
    expect(second!.extra?.["--shadow-glow"]).toBe("0 0 20px var(--accent-glow)");
  });

  it("accepts optional derived keys and rejects bad ones", () => {
    const withGrad = { ...validTheme, "grad-from": "#4c7eff", "grad-via": "#7c5cff", "grad-to": "#a855f7", "on-gradient": "#ffffff", "shadow-glow-strong": "0 0 24px rgba(108,92,231,0.45)" };
    expect(validateCustomTheme(withGrad)).not.toBeNull();
    expect(validateCustomThemeError({ ...validTheme, "grad-from": "0 2px" })).toContain("grad-from");
  });
});