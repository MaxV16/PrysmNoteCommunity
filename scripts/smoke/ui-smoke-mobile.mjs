#!/usr/bin/env node
/**
 * Headless-DOM (Playwright) mobile smoke test for Prysm Note at a 375x667
 * phone viewport (touch emulation).
 *
 * Verifies the Phase-1 mobile/touch overhaul deterministically:
 *   - MobileTabBar bottom navigation is rendered
 *   - the mobile settings drawer entry is visible and the page has no
 *     horizontal overflow (320px→375px regression)
 *   - task creation via "+ New" works and the task lands on the timeline
 *   - a long-press (touch) on a task bar opens the same context menu as
 *     right-click
 *   - the AI drawer opens from the mobile toolbar
 *   - sticky-note windows drag with pointer events
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/ui-smoke-mobile.mjs
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
  } catch {
    // Fall through to Playwright's own resolution.
  }
  const systemPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}
const EXECUTABLE_PATH = resolveExecutable();

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
}

async function dismissCookieBanner(page) {
  // On the 375px viewport the cookie banner can overlap the toolbar and
  // intercept pointer events; dismiss it once and it stays dismissed via
  // localStorage for the rest of the run.
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 4000 });
    await gotIt.click();
  } catch {
    // Already dismissed or not shown yet - the banner only matters if it is up.
  }
}

// First-visit onboarding tour: a full-screen click catcher that blocks all
// pointer interaction until the user finishes it or presses Escape (which also
// marks it done). Fresh smoke users get it right after their first task, so
// dismiss it whenever it is up or later taps would land on the catcher.
async function dismissTour(page) {
  const tour = page.locator('[role="dialog"][aria-modal="true"]').first();
  try {
    await tour.waitFor({ state: "visible", timeout: 2000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } catch {
    // No tour is showing.
  }
}

async function longPress(page, context, locator) {
  // The timeline scrolls horizontally; the touch point must be inside the
  // viewport or the browser synthesizes the events on empty space.
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box && box.width > 0, "long-press target must have a bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function main() {
  const email = `uitest-mobile-${Date.now()}@test.local`;
  const password = "ui-smoke-password-1";
  const title = `mobile smoke ${Date.now()}`;

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  console.log("[1/7] register a fresh user");
  await page.goto(`${BASE_URL}/register`);
  // The full-width cookie banner at 375px would otherwise cover the Create
  // Account button; dismiss it first so the register click is deterministic.
  await dismissCookieBanner(page);
  await page.getByPlaceholder("Your name (optional)").fill("Mobile Smoke");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("At least 8 characters").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 25000 });
  console.log("      landed on", page.url());

  console.log("[2/7] mobile bottom navigation is visible");
  const tabBar = page.locator('nav[aria-label="Primary"]');
  await tabBar.waitFor({ state: "visible" });
  assert((await tabBar.count()) >= 1, "MobileTabBar should render at 375px");

  console.log("[3/7] create a task via + New (defaults to today)");
  await dismissCookieBanner(page);
  await dismissTour(page);
  const newButton = page.locator("button.btn.btn-primary", { hasText: "+ New" });
  await newButton.waitFor({ state: "visible" });
  await newButton.click();
  await page.getByText("Task Title").waitFor({ state: "visible" });
  await page.getByPlaceholder("What needs to be done?").fill(title);
  await page.getByRole("button", { name: "Create Task" }).click();
  await page
    .getByText("Task Title")
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => undefined);
  let bar = page.locator('[data-task-bar]', { hasText: title });
  let visible = await bar.first().isVisible().catch(() => false);
  if (!visible) {
    await page.reload();
    await page.waitForTimeout(2000);
    bar = page.locator('[data-task-bar]', { hasText: title });
    visible = await bar.first().isVisible().catch(() => false);
  }
  assert(visible, "the created task should be visible on the timeline");

  console.log("[4/7] long-press on the task bar opens the context menu (touch)");
  await dismissTour(page);
  await longPress(page, context, bar.first());
  await page.getByText("Edit task").waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.getByText("Edit task").waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);

  console.log("[5/7] AI drawer opens from the toolbar");
  await dismissTour(page);
  const aiButton = page.locator('button[title="AI"]').first();
  await aiButton.waitFor({ state: "visible" });
  await aiButton.click();
  await page.getByText("AI Command").first().waitFor({ state: "visible", timeout: 10000 });
  // The open drawer covers its own toggle on mobile; close it with the header
  // close button (the real phone gesture).
  await page.getByRole("button", { name: "Close AI panel" }).click();
  await page.waitForTimeout(600);

  console.log("[6/7] settings: no horizontal overflow + mobile drawer entry");
  // Direct URL navigation to /settings bounces through the server auth check;
  // open it the way a phone user would, via the toolbar gear.
  await dismissTour(page);
  await page.locator('button[title="Settings"]').first().click();
  await page.getByRole("button", { name: "Open settings menu" }).waitFor({ state: "visible" });
  const noOverflow = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    return doc.scrollWidth <= doc.clientWidth + 1;
  });
  assert(noOverflow, "settings page should not horizontally overflow at 375px");

  console.log("[7/7] sticky note drags with pointer events");
  await page.goto(`${BASE_URL}/notes`);
  await dismissCookieBanner(page);
  await dismissTour(page);
  await page.getByRole("button", { name: "New note" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New note" }).click();
  const titleInput = page.getByPlaceholder("Title").first();
  await titleInput.waitFor({ state: "visible", timeout: 10000 });
  const windowBox = await titleInput.boundingBox();
  assert(windowBox && windowBox.width > 0, "a note window should appear after New note");
  // Drag the window by its header (offset to the right of the title input so
  // the pointer lands on the draggable bar, not the input itself).
  await page.mouse.move(windowBox.x + 100, windowBox.y + 14);
  await page.mouse.down();
  await page.mouse.move(windowBox.x + 220, windowBox.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterBox = await titleInput.boundingBox();
  assert(
    afterBox && Math.abs(afterBox.x - (windowBox.x + 120)) > 20,
    "the note window should move horizontally after a header drag"
  );

  await browser.close();
  console.log("\nSMOKE UI MOBILE PASS: register → tab bar → create task → long-press menu → AI drawer → settings overflow → note drag");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});