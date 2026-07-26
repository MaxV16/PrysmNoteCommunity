"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { ThemeName, ThemeColors, BackgroundPreset } from "@/types/theme";
import { THEMES, FONT_PRESETS, BACKGROUND_PRESETS, DEFAULT_THEME, DEFAULT_FONT } from "@/types/theme";

const CUSTOM_THEME_KEY = "prysm-custom-theme";
const FONT_KEY = "prysm-font";
const BG_KEY = "prysm-bg";
const BG_IMAGE_KEY = "prysm-bg-image";

interface ThemeContextValue {
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  toggleTheme: () => void;
  isDark: boolean;
  fontFamily: string;
  setFontFamily: (name: string) => void;
  background: { type: "none" | "preset" | "image"; value: string; size?: string };
  setBackgroundPreset: (preset: BackgroundPreset) => void;
  setBackgroundImage: (dataUrl: string) => void;
  clearBackground: () => void;
  customTheme: ThemeColors | null;
  setCustomTheme: (colors: ThemeColors | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyThemeColors(colors: ThemeColors) {
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
}

function applyFont(fontName: string) {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", `'${fontName}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
  document.body.style.fontFamily = `var(--font-ui)`;

  if (typeof document !== "undefined") {
    const existing = document.getElementById("prysm-dynamic-font");
    if (existing) existing.remove();

    const link = document.createElement("link");
    link.id = "prysm-dynamic-font";
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, "+")}:wght@400;500;600;700;800&display=swap`;
    document.head.appendChild(link);
  }
}

function applyBackground(type: string, value: string, size?: string) {
  const root = document.documentElement;
  if (type === "none" || !value) {
    root.style.removeProperty("--bg-image");
    root.style.removeProperty("--bg-size");
    root.style.removeProperty("--bg-opacity");
    return;
  }
  if (type === "image") {
    root.style.setProperty("--bg-image", `url(${value})`);
    root.style.setProperty("--bg-size", "cover");
    root.style.setProperty("--bg-opacity", "0.12");
  } else if (type === "gradient") {
    root.style.setProperty("--bg-image", value);
    root.style.setProperty("--bg-size", "cover");
    root.style.setProperty("--bg-opacity", "0.2");
  } else if (type === "pattern") {
    root.style.setProperty("--bg-image", value);
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
  const [background, setBackgroundState] = useState<{ type: string; value: string; size?: string }>({
    type: "none",
    value: "",
  });
  const [customTheme, setCustomThemeState] = useState<ThemeColors | null>(null);

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
    setCustomThemeState(ls.get<ThemeColors | null>(CUSTOM_THEME_KEY, null));
    const savedBg = ls.get<{ type: string; value: string; size?: string } | null>(BG_KEY, null);
    if (savedBg) setBackgroundState(savedBg);
  }, []);

  useEffect(() => {
    const theme = THEMES[themeName];
    if (theme) {
      applyThemeColors(theme.colors);
      document.documentElement.setAttribute("data-theme", themeName);
    }
  }, [themeName]);

  useEffect(() => {
    if (customTheme) {
      applyThemeColors(customTheme);
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
    const idx = currentThemes.indexOf(themeName);
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
    const s = { type: "image", value: dataUrl };
    setBackgroundState(s);
    ls.set(BG_KEY, s);
    ls.setStr(BG_IMAGE_KEY, dataUrl);
  }, []);

  const clearBackground = useCallback(() => {
    setBackgroundState({ type: "none", value: "" });
    ls.set(BG_KEY, { type: "none", value: "" });
    ls.setStr(BG_IMAGE_KEY, "");
  }, []);

  const setCustomTheme = useCallback((colors: ThemeColors | null) => {
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
