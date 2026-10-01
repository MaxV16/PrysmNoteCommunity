#!/usr/bin/env node
/**
 * Headless-DOM (Playwright) mobile smoke for the public marketing pages.
 *
 * Loads every marketing route at the common phone widths and asserts the
 * document never scrolls horizontally: `scrollWidth <= clientWidth + 1`, the
 * same assertion the app's own mobile smoke uses (ui-smoke-mobile.mjs). A page
 * that squishes a desktop-width mock instead of panning it fails here.
 *
 * Usage: BASE_URL=http://localhost:3000 node scripts/smoke/marketing-mobile-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const WIDTHS = [320, 375, 390, 414];
const ROUTES = [
  "/",
  "/marketing",
  "/pricing",
  "/marketing/features",
  "/marketing/downloads",
  "/marketing/changelog",
  "/marketing/legal",
  "/marketing/faq",
  "/contact",
  "/about",
  "/mcp",
  "/privacy-policy",
  "/terms-of-service",
  "/cookie-policy",
];

function resolveExecutable() {
  if (process.env.EXECUTABLE_PATH) return process.env.EXECUTABLE_PATH;
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH || `${os.homedir()}/Library/Caches/ms-playwright`;
  try {
    for (const dir of fs.readdirSync(cacheRoot)) {
      if (dir.startsWith("chromium_headless_shell-") || dir.startsWith("chromium-")) {
        for (const candidate of ["chrome-mac/headless_shell", "chrome-mac/Chromium"]) {
          const p = `${cacheRoot}/${dir}/${candidate}`;
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch {
    // Fall through to a system browser.
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const failures = [];

  for (const width of WIDTHS) {
    const page = await browser.newPage({
      viewport: { width, height: 844 },
      isMobile: width <= 430,
      hasTouch: width <= 430,
    });
    for (const route of ROUTES) {
      const res = await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle" });
      assert(res && res.status() < 400, `${route} responded ${res?.status()} at ${width}px`);
      const { scrollWidth, clientWidth } = await page.evaluate(() => {
        const doc = document.scrollingElement || document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });
      if (scrollWidth > clientWidth + 1) {
        failures.push(`${route} @ ${width}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
      }
    }
    console.log(`  ${width}px: checked ${ROUTES.length} routes`);
    await page.close();
  }

  await browser.close();

  if (failures.length > 0) {
    console.error("Horizontal overflow found:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nSMOKE MARKETING MOBILE PASS: no horizontal overflow at 320/375/390/414px");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
