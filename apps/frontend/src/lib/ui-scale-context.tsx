"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Device-local interface size. A single multiplier (0.75 to 1.3) that scales the
 * timeline density and the non-interactive text so a task can make the app fit a
 * phone screen or grow it for a large monitor. It is kept in localStorage like
 * the theme, so each device can choose its own size, and it is applied through
 * the `--ui-scale` CSS variable so text scales live without a reload.
 *
 * It deliberately does NOT shrink the root font-size: tap targets stay at the
 * 44px minimum enforced by the pointer-coarse rules in globals.css.
 */
export const UI_SCALE_KEY = "prysm_ui_scale";
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.3;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1;

/**
 * Device-local font size. A separate multiplier (0.75 to 1.75) that scales text
 * only, without touching the timeline density, so the two controls stay
 * independent: Interface Size fits the layout, Font Size fits readability. It is
 * applied through the `--font-scale` CSS variable and stored per device, exactly
 * like the interface size.
 */
export const FONT_SCALE_KEY = "prysm_font_scale";
export const FONT_SCALE_MIN = 0.75;
export const FONT_SCALE_MAX = 1.75;
export const FONT_SCALE_STEP = 0.05;
export const FONT_SCALE_DEFAULT = 1;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(max, Math.max(min, rounded));
}

function clampScale(value: number): number {
  return clamp(value, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_DEFAULT);
}

function clampFontScale(value: number): number {
  return clamp(value, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT);
}

/**
 * Phones start a little smaller so more of the timeline fits without the user
 * having to touch the slider, then the choice sticks for that device.
 */
function deviceDefaultScale(): number {
  if (typeof window === "undefined") return UI_SCALE_DEFAULT;
  return window.innerWidth <= 767 ? 0.9 : UI_SCALE_DEFAULT;
}

interface UiScaleContextValue {
  scale: number;
  setScale: (value: number) => void;
  resetScale: () => void;
  min: number;
  max: number;
  step: number;
  fontScale: number;
  setFontScale: (value: number) => void;
  resetFontScale: () => void;
  fontMin: number;
  fontMax: number;
  fontStep: number;
}

const UiScaleContext = createContext<UiScaleContextValue>({
  scale: UI_SCALE_DEFAULT,
  setScale: () => {},
  resetScale: () => {},
  min: UI_SCALE_MIN,
  max: UI_SCALE_MAX,
  step: UI_SCALE_STEP,
  fontScale: FONT_SCALE_DEFAULT,
  setFontScale: () => {},
  resetFontScale: () => {},
  fontMin: FONT_SCALE_MIN,
  fontMax: FONT_SCALE_MAX,
  fontStep: FONT_SCALE_STEP,
});

/** Read the current interface and font size. Safe outside the provider (returns 1). */
export function useUiScale(): UiScaleContextValue {
  return useContext(UiScaleContext);
}

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(UI_SCALE_DEFAULT);
  const [fontScale, setFontScaleState] = useState(FONT_SCALE_DEFAULT);

  // Read the stored choices on mount. No stored value falls back to the device
  // default so a fresh phone starts slightly denser than a fresh desktop.
  useEffect(() => {
    let initial = deviceDefaultScale();
    let initialFont = FONT_SCALE_DEFAULT;
    try {
      const raw = localStorage.getItem(UI_SCALE_KEY);
      if (raw != null && raw !== "") initial = clampScale(parseFloat(raw));
      const rawFont = localStorage.getItem(FONT_SCALE_KEY);
      if (rawFont != null && rawFont !== "") initialFont = clampFontScale(parseFloat(rawFont));
    } catch {
      /* storage unavailable, keep the defaults */
    }
    setScaleState(initial);
    setFontScaleState(initialFont);
  }, []);

  // Publish to CSS (and the timeline hooks) without a reload.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--ui-scale", String(scale));
    }
  }, [scale]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--font-scale", String(fontScale));
    }
  }, [fontScale]);

  const setScale = useCallback((value: number) => {
    const next = clampScale(value);
    setScaleState(next);
    try {
      localStorage.setItem(UI_SCALE_KEY, String(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, []);

  const setFontScale = useCallback((value: number) => {
    const next = clampFontScale(value);
    setFontScaleState(next);
    try {
      localStorage.setItem(FONT_SCALE_KEY, String(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, []);

  const resetScale = useCallback(() => setScale(UI_SCALE_DEFAULT), [setScale]);
  const resetFontScale = useCallback(() => setFontScale(FONT_SCALE_DEFAULT), [setFontScale]);

  const value = useMemo<UiScaleContextValue>(
    () => ({
      scale,
      setScale,
      resetScale,
      min: UI_SCALE_MIN,
      max: UI_SCALE_MAX,
      step: UI_SCALE_STEP,
      fontScale,
      setFontScale,
      resetFontScale,
      fontMin: FONT_SCALE_MIN,
      fontMax: FONT_SCALE_MAX,
      fontStep: FONT_SCALE_STEP,
    }),
    [scale, setScale, resetScale, fontScale, setFontScale, resetFontScale]
  );

  return <UiScaleContext.Provider value={value}>{children}</UiScaleContext.Provider>;
}
