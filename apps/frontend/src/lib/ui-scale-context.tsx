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
 * Device-local interface size. A single multiplier (0.8 to 1.3) that scales the
 * timeline density and the non-interactive text so a task can make the app fit a
 * phone screen or grow it for a large monitor. It is kept in localStorage like
 * the theme, so each device can choose its own size, and it is applied through
 * the `--ui-scale` CSS variable so text scales live without a reload.
 *
 * It deliberately does NOT shrink the root font-size: tap targets stay at the
 * 44px minimum enforced by the pointer-coarse rules in globals.css.
 */
export const UI_SCALE_KEY = "prysm_ui_scale";
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.3;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_DEFAULT;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, rounded));
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
}

const UiScaleContext = createContext<UiScaleContextValue>({
  scale: UI_SCALE_DEFAULT,
  setScale: () => {},
  resetScale: () => {},
  min: UI_SCALE_MIN,
  max: UI_SCALE_MAX,
  step: UI_SCALE_STEP,
});

/** Read the current interface size. Safe outside the provider (returns 1). */
export function useUiScale(): UiScaleContextValue {
  return useContext(UiScaleContext);
}

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(UI_SCALE_DEFAULT);

  // Read the stored choice on mount. No stored value falls back to the device
  // default so a fresh phone starts slightly denser than a fresh desktop.
  useEffect(() => {
    let initial = deviceDefaultScale();
    try {
      const raw = localStorage.getItem(UI_SCALE_KEY);
      if (raw != null && raw !== "") initial = clampScale(parseFloat(raw));
    } catch {
      /* storage unavailable, keep the device default */
    }
    setScaleState(initial);
  }, []);

  // Publish to CSS (and the timeline hooks) without a reload.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--ui-scale", String(scale));
    }
  }, [scale]);

  const setScale = useCallback((value: number) => {
    const next = clampScale(value);
    setScaleState(next);
    try {
      localStorage.setItem(UI_SCALE_KEY, String(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, []);

  const resetScale = useCallback(() => setScale(UI_SCALE_DEFAULT), [setScale]);

  const value = useMemo<UiScaleContextValue>(
    () => ({
      scale,
      setScale,
      resetScale,
      min: UI_SCALE_MIN,
      max: UI_SCALE_MAX,
      step: UI_SCALE_STEP,
    }),
    [scale, setScale, resetScale]
  );

  return <UiScaleContext.Provider value={value}>{children}</UiScaleContext.Provider>;
}
