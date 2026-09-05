"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { ThemeName, ThemeColors, BackgroundPreset, CustomTheme } from "@/types/theme";
import { THEMES, FONT_PRESETS, BACKGROUND_PRESETS, DEFAULT_THEME, DEFAULT_FONT } from "@/types/theme";
import { KNOWN_CSS_VARS } from "@/lib/theme-vars";

const CUSTOM_THEME_KEY = "prysm-custom-theme";
const FONT_KEY = "prysm-font";
const BG_KEY = "prysm-bg";
const BG_IMAGE_KEY = "prysm-bg-image";

type BackgroundState = {
  type: "none" | "gradient" | "pattern" | "image";
  value: string;
  size?: string;
};

interface ThemeContextValue {
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  toggleTheme: () => void;
  isDark: boolean;
  fontFamily: string;
  setFontFamily: (name: string) => void;
  background: BackgroundState;
  setBackgroundPreset: (preset: BackgroundPreset) => void;
  setBackgroundImage: (dataUrl: string) => void;
  clearBackground: () => void;
  customTheme: CustomTheme | null;
  setCustomTheme: (colors: CustomTheme | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const appliedExtras = new Set<string>();

function applyThemeColors(colors: ThemeColors, extra?: Record<string, string>) {
  const root = document.documentElement;
  root.style.setProperty("--bg-base", colors.base);
  root.style.setProperty("--bg-surface", colors.surface);
  root.style.setProperty("--bg-elevated", colors.elevated);
  root.style.setProperty("--bg-hover", colors.hover);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--text-primary", colors.primary);
  root.style.setProperty("--text-secondary", colors.secondary);
  root.style.setProperty("--text-muted", colors.muted);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-hover", colors["accent-hover"]);
  root.style.setProperty("--danger", colors.danger);
  root.style.setProperty("--success", colors.success);
  root.style.setProperty("--warning", colors.warning);
  root.style.setProperty("--shadow-sm", colors["shadow-sm"]);
  root.style.setProperty("--shadow-md", colors["shadow-md"]);
  root.style.setProperty("--shadow-lg", colors["shadow-lg"]);
  root.style.setProperty("--accent-glow", colors["accent-glow"]);
  // Primary gradient + glow (pricing-page design language). Custom themes derive
  // these from the accent so gradient CTAs stay cohesive without extra fields.
  root.style.setProperty("--grad-from", colors["grad-from"] ?? colors.accent);
  root.style.setProperty("--grad-via", colors["grad-via"] ?? colors.accent);
  root.style.setProperty(
    "--grad-to",
    colors["grad-to"] ?? colors["accent-hover"] ?? colors.accent,
  );
  root.style.setProperty(
    "--on-gradient",
    colors["on-gradient"] ?? (luminance(colors.accent) > 0.35 ? "#1a1a2e" : "#ffffff"),
  );
  root.style.setProperty(
    "--shadow-glow-strong",
    colors["shadow-glow-strong"] ?? `0 0 24px ${colors["accent-glow"]}`,
  );
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (KNOWN_CSS_VARS.has(name)) {
        root.style.setProperty(name, value);
        appliedExtras.add(name);
      }
    }
  }
}

function clearExtras() {
  const root = document.documentElement;
  for (const name of appliedExtras) {
    root.style.removeProperty(name);
  }
  appliedExtras.clear();
}

// Relative luminance (WCAG) of a hex color - used to pick readable text on the
// gradient for custom themes with a light accent.
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sanitizeFontName(fontName: string): string {
  // Font family names must be plain: letters/digits/spaces/hyphens only, so a
  // stored "font" value can never inject extra CSS into --font-ui (L5).
  const cleaned = fontName.replace(/[^A-Za-z0-9 \-]/g, "").trim();
  return cleaned && cleaned.length <= 60 ? cleaned : "";
}

// Background values are dropped into CSS custom properties; only allow a
// conservative CSS grammar (no quotes, parens-URL breakouts, semicolons, or
// < > which could smuggle script-ish syntax).
const _SAFE_BG_RE = /^[A-Za-z0-9 %#(),.+\-]+$/;

function sanitizeBackgroundValue(value: string): string {
  const v = value.trim();
  return v.length <= 500 && _SAFE_BG_RE.test(v) ? v : "";
}

function applyFont(fontName: string) {
  const safe = sanitizeFontName(fontName);
  if (!safe) return;
  const root = document.documentElement;
  root.style.setProperty("--font-ui", `'${safe}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
  document.body.style.fontFamily = `var(--font-ui)`;

  if (typeof document !== "undefined") {
    const existing = document.getElementById("prysm-dynamic-font");
    if (existing) existing.remove();

    const link = document.createElement("link");
    link.id = "prysm-dynamic-font";
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${safe.replace(/ /g, "+")}:wght@400;500;600;700;800&display=swap`;
    document.head.appendChild(link);
  }
}

function applyBackground(type: string, value: string, size?: string) {
  const safe = sanitizeBackgroundValue(value);
  const root = document.documentElement;
  if (type === "none" || !safe) {
    root.style.removeProperty("--bg-image");
    root.style.removeProperty("--bg-size");
    root.style.removeProperty("--bg-opacity");
    root.style.removeProperty("--bg-image-display");
    return;
  }
  root.style.setProperty("--bg-image-display", "block");
  if (type === "image") {
    // Only plain http(s) image URLs are acceptable as url() input.
    if (!/^https?:\/\//.test(safe)) return;
    root.style.setProperty("--bg-image", `url(${safe})`);
    root.style.setProperty("--bg-size", "cover");
    root.style.setProperty("--bg-opacity", "0.12");
  } else if (type === "gradient") {
    root.style.setProperty("--bg-image", safe);
    root.style.setProperty("--bg-size", "cover");
    root.style.setProperty("--bg-opacity", "0.2");
  } else if (type === "pattern") {
    root.style.setProperty("--bg-image", safe);
    root.style.setProperty("--bg-size", size || "40px 40px");
    root.style.setProperty("--bg-opacity", "1");
  }
}

const ls = {
  get: <T,>(key: string, fallback: T): T => {
    if (typeof window === "undefined") return fallback;
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set: (key: string, value: unknown) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  },
  getStr: (key: string, fallback = ""): string => {
    if (typeof window === "undefined") return fallback;
    return localStorage.getItem(key) || fallback;
  },
  setStr: (key: string, value: string) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, value);
  },
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeNameState] = useState<ThemeName>(DEFAULT_THEME);
  const [fontFamily, setFontFamilyState] = useState(DEFAULT_FONT);
  const [background, setBackgroundState] = useState<BackgroundState>({
    type: "none",
    value: "",
  });
  const [customTheme, setCustomThemeState] = useState<CustomTheme | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("prysm-theme") as ThemeName | null;
    if (stored && THEMES[stored]) {
      setThemeNameState(stored);
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const initial: ThemeName = prefersDark ? "dark" : "light";
      setThemeNameState(initial);
    }
    setFontFamilyState(ls.getStr(FONT_KEY, DEFAULT_FONT));
    setCustomThemeState(ls.get<CustomTheme | null>(CUSTOM_THEME_KEY, null));
    const savedBg = ls.get<{ type: string; value: string; size?: string } | null>(BG_KEY, null);
    if (savedBg && ["none", "gradient", "pattern", "image"].includes(savedBg.type)) {
      setBackgroundState(savedBg as BackgroundState);
    }
  }, []);

  useEffect(() => {
    const theme = THEMES[themeName];
    if (theme) {
      clearExtras();
      applyThemeColors(theme.colors);
      document.documentElement.setAttribute("data-theme", themeName);
    }
  }, [themeName]);

  useEffect(() => {
    if (customTheme) {
      // A previous custom theme's extras must not leak into a new one: clear
      // the applied set first, then re-apply this theme's extras.
      clearExtras();
      applyThemeColors(customTheme, customTheme.extra);
      document.documentElement.setAttribute("data-theme", "custom");
    }
  }, [customTheme]);

  useEffect(() => {
    applyFont(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    applyBackground(background.type, background.value, background.size);
  }, [background]);

  const setThemeName = useCallback((name: ThemeName) => {
    setThemeNameState(name);
    localStorage.setItem("prysm-theme", name);
    if (name !== "custom") {
      setCustomThemeState(null);
      ls.set(CUSTOM_THEME_KEY, null);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const themes = Object.keys(THEMES) as ThemeName[];
    const currentThemes = themes.filter((t) => t !== "custom");
    const idx = currentThemes.indexOf(themeName as Exclude<ThemeName, "custom">);
    const next = idx >= 0 ? currentThemes[(idx + 1) % currentThemes.length] : currentThemes[0];
    setThemeName(next);
  }, [themeName, setThemeName]);

  const setFontFamily = useCallback((name: string) => {
    setFontFamilyState(name);
    ls.setStr(FONT_KEY, name);
  }, []);

  const setBackgroundPreset = useCallback((preset: BackgroundPreset) => {
    if (preset.type === "none") {
      setBackgroundState({ type: "none", value: "" });
      ls.set(BG_KEY, { type: "none", value: "" });
      ls.setStr(BG_IMAGE_KEY, "");
    } else {
      const s = { type: preset.type, value: preset.value, size: preset.size };
      setBackgroundState(s);
      ls.set(BG_KEY, s);
    }
  }, []);

  const setBackgroundImage = useCallback((dataUrl: string) => {
    const s: BackgroundState = { type: "image", value: dataUrl };
    setBackgroundState(s);
    ls.set(BG_KEY, s);
    ls.setStr(BG_IMAGE_KEY, dataUrl);
  }, []);

  const clearBackground = useCallback(() => {
    setBackgroundState({ type: "none", value: "" });
    ls.set(BG_KEY, { type: "none", value: "" });
    ls.setStr(BG_IMAGE_KEY, "");
  }, []);

  const setCustomTheme = useCallback((colors: CustomTheme | null) => {
    setCustomThemeState(colors);
    ls.set(CUSTOM_THEME_KEY, colors);
    if (colors) setThemeNameState("custom");
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        themeName,
        setThemeName,
        toggleTheme,
        isDark: themeName !== "light",
        fontFamily,
        setFontFamily,
        background,
        setBackgroundPreset,
        setBackgroundImage,
        clearBackground,
        customTheme,
        setCustomTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
