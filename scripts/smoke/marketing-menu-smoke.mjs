#!/usr/bin/env node
/**
 * Headless-DOM regression check for the marketing mobile menu overlay.
 *
 * Guards against two bugs that made the open menu transparent and let the hero
 * show through:
 *   1. the overlay lived inside the header, which has `backdrop-blur` and so
 *      became the containing block for the fixed-position overlay (collapsing
 *      it to the header's 64px box), and
 *   2. Tailwind's content globs did not include the EE marketing directory, so
 *      utilities used only there (e.g. `top-16`) were never generated.
 *
 * Coordinate-free: asserts the dialog's geometry, opaque background, and that
 * the element actually painted at the viewport centre is the dialog itself.
 *
 * It also guards the changelog being reachable: the nav must link it and the
 * page must render entries (it used to be buried on the home page only).
 *
 * Usage: BASE_URL=http://localhost:3000 node scripts/smoke/marketing-menu-smoke.mjs
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
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  console.log("[1/5] open a marketing page on a phone viewport");
  await page.goto(`${BASE_URL}/marketing/features`, { waitUntil: "networkidle" });

  console.log("[2/5] open the mobile menu");
  const toggle = page.getByRole("button", { name: "Toggle navigation menu" });
  await toggle.waitFor({ state: "visible" });
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.waitFor({ state: "visible" });

  console.log("[3/5] assert the overlay covers the viewport and is not transparent");
  assert(
    (await dialog.evaluate((el) => el.closest("header") === null)),
    "menu overlay must be rendered outside the backdrop-blur header",
  );

  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  assert(!!box && box.y >= 40 && box.y <= 90, `overlay must start just below the header (got y=${box?.y})`);
  assert(box.width >= viewport.width - 1, "overlay must span the full width");
  assert(box.height >= viewport.height - box.y - 1, "overlay must reach the bottom of the screen");

  const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(!/rgba\(0, 0, 0, 0\)|transparent/.test(bg), `overlay background must be opaque (got ${bg})`);

  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el ? !!el.closest('[role="dialog"]') : false;
  });
  assert(hit, "the dialog must be the element painted at the viewport centre");

  console.log("[4/5] the changelog must be reachable from the menu");
  const changelogLink = dialog.getByRole("link", { name: "Changelog" });
  await changelogLink.waitFor({ state: "visible" });
  assert(
    (await changelogLink.getAttribute("href")) === "/marketing/changelog",
    "the Changelog link must point at /marketing/changelog",
  );

  console.log("[5/5] the changelog page renders release entries");
  await changelogLink.click();
  await page.waitForURL("**/marketing/changelog");
  await page.getByRole("heading", { name: "Changelog", level: 1 }).waitFor({ state: "visible" });
  assert(
    (await page.locator("text=/^v\\d+\\.\\d+\\.\\d+$/").first().count()) > 0,
    "the changelog page must render at least one version badge",
  );

  await browser.close();
  console.log("\nSMOKE MARKETING MENU PASS: opaque mobile menu + changelog is reachable");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
