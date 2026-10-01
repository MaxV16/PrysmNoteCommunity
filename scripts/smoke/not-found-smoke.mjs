#!/usr/bin/env node
/**
 * Regression check for the custom 404 page.
 *
 * A bogus URL must return HTTP 404 (not a soft-200 redirect) and render the
 * branded not-found view with its heading and a primary call to action, instead
 * of a blank page or the framework default.
 *
 * Coordinate-free: asserts the response status plus visible role/text targets.
 *
 * Usage: BASE_URL=http://localhost:3000 node scripts/smoke/not-found-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

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
  } catch {}
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
  if (!cond) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const bogus = `/this-page-does-not-exist-${Date.now()}`;
  console.log(`[1/3] request a bogus path: ${bogus}`);
  const response = await page.goto(`${BASE_URL}${bogus}`, { waitUntil: "domcontentloaded" });
  assert(response, "expected an HTTP response for the bogus path");
  assert(
    response.status() === 404,
    `expected HTTP 404 for a bogus path (got ${response.status()})`
  );

  console.log("[2/3] the branded heading is visible");
  await page
    .getByRole("heading", { name: "We could not find that page" })
    .waitFor({ state: "visible", timeout: 10000 });

  console.log("[3/3] a primary action is available");
  const cta = page.getByRole("link", { name: /Start for free|Back to your workspace/ });
  await cta.first().waitFor({ state: "visible" });

  await browser.close();
  console.log("\nSMOKE 404 PASS: bogus path returns 404 with the branded not-found view");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
