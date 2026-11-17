"use client";

import { useEffect } from "react";
import {
  APPEARANCE_EVENT,
  APPEARANCE_KEY,
  applyAppearance,
  loadAppearance,
} from "@/lib/appearance";

/**
 * Applies the stored appearance on first paint (after hydration) and keeps it
 * in sync when the settings panel saves or another tab changes the value. It
 * renders nothing of its own: the whole layer is a dataset attribute plus four
 * CSS variables on `:root`.
 */
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyAppearance(loadAppearance());

    const onChange = () => applyAppearance(loadAppearance());
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY) onChange();
    };
    window.addEventListener(APPEARANCE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return <>{children}</>;
}
