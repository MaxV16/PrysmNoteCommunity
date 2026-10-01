"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Compact dark/light toggle for the logged-out auth pages, so a visitor can
 * match their preference before signing in. Uses the same theme store as the
 * app, so the choice carries into the workspace.
 */
export function AuthThemeToggle() {
  const { isDark, themeName, setThemeName } = useTheme();
  return (
    <button
      type="button"
      onClick={() => setThemeName(themeName === "light" ? "dark" : "light")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light theme" : "Dark theme"}
      className="icon-btn absolute right-4 top-4"
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
