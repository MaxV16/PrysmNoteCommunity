import tokens from "@/design-tokens.json";

export type ThemeName = "dark" | "light" | "dracula" | "nord" | "monokai" | "slate" | "coffee" | "solarized" | "github-dark" | "tokyo" | "custom";

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
}

export interface Theme {
  label: string;
  colors: ThemeColors;
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
export const DEFAULT_FONT = "Inter";
