import { defineConfig } from "@playwright/test";

/**
 * Configuration used by scripts/smoke/ui-smoke.mjs. Not tied to any test
 * runner glob; we launch Chromium directly in the script. This file only
 * pins the browser and tells `@playwright/test` (when its runner is invoked)
 * where to look, so the smoke harness behaves sensibly out of the box.
 */
export default defineConfig({
  testDir: "./scripts/smoke",
  use: {
    headless: process.env.HEADLESS !== "0",
    baseURL: process.env.BASE_URL || "http://localhost:3000",
  },
});
