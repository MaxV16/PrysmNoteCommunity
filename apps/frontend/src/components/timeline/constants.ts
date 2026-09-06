import { useEffect, useState } from "react";

export const DAY_WIDTH = 120;
export const DAY_HEADER_HEIGHT = 56;
export const BAR_HEIGHT = 40;
export const BAR_GAP = 8;
export const TOP_PADDING = 5;

/**
 * Responsive day column width: ~5-6 days visible on phones instead of the 120px
 * desktop width (clamp(56px, 15vw, 120px)). Listening to `resize` keeps the
 * density live when a phone rotates or a desktop window resizes.
 */
export function useResponsiveDayWidth(): number {
  const [width, setWidth] = useState(DAY_WIDTH);
  useEffect(() => {
    const update = () => {
      const vw = typeof window === "undefined" ? 120 : window.innerWidth;
      setWidth(Math.round(Math.min(DAY_WIDTH, Math.max(56, vw * 0.15))));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}