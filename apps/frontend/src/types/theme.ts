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
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    label: "Dark",
    colors: {
      base: "#0a0a0d",
      surface: "#121216",
      elevated: "#1a1a20",
      hover: "#24242d",
      border: "#2e2e3a",
      primary: "#eeeef0",
      secondary: "#9898a8",
      muted: "#5e5e6e",
      accent: "#6ee7ff",
      "accent-hover": "#50d5f0",
      danger: "#ff5555",
      success: "#6fcf7a",
      warning: "#ffb84d",
      "shadow-sm": "0 2px 6px rgba(0,0,0,0.3)",
      "shadow-md": "0 6px 16px rgba(0,0,0,0.4)",
      "shadow-lg": "0 12px 32px rgba(0,0,0,0.5)",
    },
  },
  light: {
    name: "light",
    label: "Light",
    colors: {
      base: "#ffffff",
      surface: "#f5f5f5",
      elevated: "#ebebeb",
      hover: "#e0e0e0",
      border: "#d4d4d4",
      primary: "#1a1a1a",
      secondary: "#555555",
      muted: "#999999",
      accent: "#1976d2",
      "accent-hover": "#1565c0",
      danger: "#d32f2f",
      success: "#388e3c",
      warning: "#f57c00",
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.08)",
      "shadow-md": "0 2px 8px rgba(0,0,0,0.1)",
      "shadow-lg": "0 4px 16px rgba(0,0,0,0.12)",
    },
  },
  dracula: {
    name: "dracula",
    label: "Dracula",
    colors: {
      base: "#282a36",
      surface: "#2d2f3e",
      elevated: "#363849",
      hover: "#3d3f52",
      border: "#44475a",
      primary: "#f8f8f2",
      secondary: "#c0c0c0",
      muted: "#6272a4",
      accent: "#bd93f9",
      "accent-hover": "#caa9fa",
      danger: "#ff5555",
      success: "#50fa7b",
      warning: "#ffb86c",
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.4)",
      "shadow-md": "0 2px 8px rgba(0,0,0,0.4)",
      "shadow-lg": "0 4px 16px rgba(0,0,0,0.5)",
    },
  },
  nord: {
    name: "nord",
    label: "Nord",
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
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.3)",
      "shadow-md": "0 2px 8px rgba(0,0,0,0.35)",
      "shadow-lg": "0 4px 16px rgba(0,0,0,0.45)",
    },
  },
  monokai: {
    name: "monokai",
    label: "Monokai",
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
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.35)",
      "shadow-md": "0 2px 8px rgba(0,0,0,0.4)",
      "shadow-lg": "0 4px 16px rgba(0,0,0,0.5)",
    },
  },
};