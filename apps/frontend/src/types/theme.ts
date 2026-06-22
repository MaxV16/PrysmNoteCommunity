export type ThemeName = "dark" | "light" | "dracula" | "nord" | "monokai";

export interface Theme {
  name: ThemeName;
  label: string;
  colors: ThemeColors;
}

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

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    label: "Deep Space",
    colors: {
      base: "#07070b",
      surface: "#0f0f16",
      elevated: "#181820",
      hover: "#22222e",
      border: "#2a2a3a",
      primary: "#f0f0f4",
      secondary: "#a0a0b4",
      muted: "#60607a",
      accent: "#6c5ce7",
      "accent-hover": "#7f70f0",
      danger: "#ff4757",
      success: "#2ed573",
      warning: "#ffa502",
      "shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
      "shadow-md": "0 8px 24px rgba(0,0,0,0.6)",
      "shadow-lg": "0 16px 48px rgba(0,0,0,0.7)",
      "accent-glow": "rgba(108,92,231,0.35)",
    },
  },
  light: {
    name: "light",
    label: "Lavender Light",
    colors: {
      base: "#f5f0ff",
      surface: "#ffffff",
      elevated: "#ede8f8",
      hover: "#e0d8f0",
      border: "#d0c8e0",
      primary: "#1a0a2e",
      secondary: "#5a4a72",
      muted: "#9280a8",
      accent: "#6c5ce7",
      "accent-hover": "#5a4ad0",
      danger: "#e53e3e",
      success: "#38a169",
      warning: "#dd6b20",
      "shadow-sm": "0 1px 3px rgba(60,40,100,0.08)",
      "shadow-md": "0 4px 12px rgba(60,40,100,0.12)",
      "shadow-lg": "0 8px 24px rgba(60,40,100,0.16)",
      "accent-glow": "rgba(108,92,231,0.2)",
    },
  },
  dracula: {
    name: "dracula",
    label: "Dracula Night",
    colors: {
      base: "#21222c",
      surface: "#282a36",
      elevated: "#2d2f3e",
      hover: "#363849",
      border: "#44475a",
      primary: "#f8f8f2",
      secondary: "#c0c0c0",
      muted: "#6272a4",
      accent: "#bd93f9",
      "accent-hover": "#caa9fa",
      danger: "#ff5555",
      success: "#50fa7b",
      warning: "#ffb86c",
      "shadow-sm": "0 2px 8px rgba(0,0,0,0.5)",
      "shadow-md": "0 8px 24px rgba(0,0,0,0.55)",
      "shadow-lg": "0 16px 48px rgba(0,0,0,0.6)",
      "accent-glow": "rgba(189,147,249,0.35)",
    },
  },
  nord: {
    name: "nord",
    label: "Arctic Frost",
    colors: {
      base: "#2e3440",
      surface: "#3b4252",
      elevated: "#434c5e",
      hover: "#4c566a",
      border: "#4c566a",
      primary: "#eceff4",
      secondary: "#d8dee9",
      muted: "#81a1c1",
      accent: "#88c0d0",
      "accent-hover": "#8fbcbb",
      danger: "#bf616a",
      success: "#a3be8c",
      warning: "#ebcb8b",
      "shadow-sm": "0 2px 8px rgba(0,0,0,0.4)",
      "shadow-md": "0 8px 24px rgba(0,0,0,0.45)",
      "shadow-lg": "0 16px 48px rgba(0,0,0,0.5)",
      "accent-glow": "rgba(136,192,208,0.3)",
    },
  },
  monokai: {
    name: "monokai",
    label: "Monokai Blaze",
    colors: {
      base: "#272822",
      surface: "#2c2d27",
      elevated: "#353631",
      hover: "#3e3d32",
      border: "#49483e",
      primary: "#f8f8f2",
      secondary: "#a6e22e",
      muted: "#75715e",
      accent: "#66d9ef",
      "accent-hover": "#a6e22e",
      danger: "#f92672",
      success: "#a6e22e",
      warning: "#fd971f",
      "shadow-sm": "0 2px 8px rgba(0,0,0,0.45)",
      "shadow-md": "0 8px 24px rgba(0,0,0,0.5)",
      "shadow-lg": "0 16px 48px rgba(0,0,0,0.55)",
      "accent-glow": "rgba(102,217,239,0.35)",
    },
  },
};