"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { ThemeName } from "@/types/theme";
import { THEMES } from "@/types/theme";

interface ThemeContextValue {
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  toggleTheme: () => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(name: ThemeName) {
  const theme = THEMES[name];
  if (!theme) return;
  const root = document.documentElement;
  const c = theme.colors;
  root.style.setProperty("--bg-base", c.base);
  root.style.setProperty("--bg-surface", c.surface);
  root.style.setProperty("--bg-elevated", c.elevated);
  root.style.setProperty("--bg-hover", c.hover);
  root.style.setProperty("--border", c.border);
  root.style.setProperty("--text-primary", c.primary);
  root.style.setProperty("--text-secondary", c.secondary);
  root.style.setProperty("--text-muted", c.muted);
  root.style.setProperty("--accent", c.accent);
  root.style.setProperty("--accent-hover", c["accent-hover"]);
  root.style.setProperty("--danger", c.danger);
  root.style.setProperty("--success", c.success);
  root.style.setProperty("--warning", c.warning);
  root.style.setProperty("--shadow-sm", c["shadow-sm"]);
  root.style.setProperty("--shadow-md", c["shadow-md"]);
  root.style.setProperty("--shadow-lg", c["shadow-lg"]);
  root.setAttribute("data-theme", name);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeNameState] = useState<ThemeName>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("prysm-theme") as ThemeName | null;
    if (stored && THEMES[stored]) {
      setThemeNameState(stored);
      applyTheme(stored);
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const initial: ThemeName = prefersDark ? "dark" : "light";
      setThemeNameState(initial);
      applyTheme(initial);
    }
  }, []);

  const setThemeName = useCallback((name: ThemeName) => {
    setThemeNameState(name);
    localStorage.setItem("prysm-theme", name);
    applyTheme(name);
  }, []);

  const toggleTheme = useCallback(() => {
    const themes: ThemeName[] = ["dark", "light", "dracula", "nord", "monokai"];
    const idx = themes.indexOf(themeName);
    const next = themes[(idx + 1) % themes.length];
    setThemeName(next);
  }, [themeName, setThemeName]);

  return (
    <ThemeContext.Provider value={{ themeName, setThemeName, toggleTheme, isDark: themeName !== "light" }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}