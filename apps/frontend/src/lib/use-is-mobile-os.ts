"use client";

import { useEffect, useState } from "react";
import { detectOS } from "@/lib/browser";

/**
 * True on phones/tablets running iOS or Android (including iPadOS, which
 * reports a Mac user agent). Used to keep desktop-only features such as the
 * floating sticky notes out of the mobile UI. Hydration-safe: false on the
 * server and first client render, then resolved after mount.
 */
export function useIsMobileOS(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const os = detectOS(typeof navigator !== "undefined" ? navigator.userAgent : "");
    setIsMobile(os === "ios" || os === "android");
  }, []);
  return isMobile;
}
