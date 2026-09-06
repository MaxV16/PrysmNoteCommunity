"use client";

import { useEffect } from "react";
import { initCapbridge } from "@/lib/capbridge";

/**
 * Mounted once in the root layout. Wires the Capacitor native bridges (SSO
 * deep links, hardware back button, keyboard, status bar) when the app runs
 * inside the WebView; a no-op elsewhere.
 */
export function CapbridgeInit() {
  useEffect(() => {
    initCapbridge();
  }, []);
  return null;
}