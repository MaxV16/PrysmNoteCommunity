"use client";

import { useEffect } from "react";
import { useTheme } from "@/lib/theme-context";

export function DynamicFontLoader() {
  const { fontFamily } = useTheme();

  useEffect(() => {
    const id = "prysm-dynamic-font";

    const existing = document.getElementById(id);
    if (existing) existing.remove();

    if (fontFamily === "Inter") return;

    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    const encoded = fontFamily.replace(/ /g, "+");
    link.href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@400;500;600;700;800&display=swap`;
    document.head.appendChild(link);

    return () => {
      link.remove();
    };
  }, [fontFamily]);

  return null;
}
