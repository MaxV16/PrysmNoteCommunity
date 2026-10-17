import tokens from "@/design-tokens.json";

export type ThemeName = "dark" | "light" | "parchment" | "fog" | "dusk" | "dracula" | "nord" | "monokai" | "slate" | "coffee" | "solarized" | "github-dark" | "tokyo" | "ocean" | "forest" | "sunset" | "custom";

export interface ThemeColors {
  base: string;
  surface: string;
  elevated: string;
  hover: string;
  border: string;
  primary: string;
  secondary: string;
  muted: string;
  accent: string;
  "accent-hover": string;
  danger: string;
  success: string;
  warning: string;
  "shadow-sm": string;
  "shadow-md": string;
  "shadow-lg": string;
  "accent-glow": string;
  "on-gradient"?: string;
  /* Optional chrome pair for mixed themes (dark sidebar over light content). */
  "chrome-bg"?: string;
  "chrome-border"?: string;
  "chrome-text"?: string;
  "chrome-text-secondary"?: string;
  "chrome-text-muted"?: string;
}

export interface Theme {
  label: string;
  colors: ThemeColors;
}

export interface CustomTheme extends ThemeColors {
  label?: string;
  extra?: Record<string, string>;
}

export interface BackgroundPreset {
  id: string;
  label: string;
  type: "none" | "gradient" | "pattern";
  value: string;
  size?: string;
}

export const THEMES = tokens.themes as unknown as Record<ThemeName, Theme>;
export const FONT_PRESETS = tokens.fontPresets as string[];
export const BACKGROUND_PRESETS = tokens.backgroundPresets as BackgroundPreset[];

export const DEFAULT_THEME: ThemeName = "dark";
export const DEFAULT_FONT = "IBM Plex Sans";
