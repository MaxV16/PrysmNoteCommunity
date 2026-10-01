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
 *   - a quick touch drag on a task bar pans the timeline instead of moving it
 *   - a long-press (touch) on a task bar opens the mobile action bar
 *     (Done / Duplicate / Move / Delete)
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

// The phone toolbar is a single scroll row; the view switcher and the period
// nav must sit fully inside the viewport without scrolling (they were the
// controls clipped in half). Measure without scrollIntoViewIfNeeded so a
// clipped control still reports an out-of-viewport box.
async function assertToolbarControlsInViewport(page) {
  const vw = page.viewportSize().width;
  await page.getByTestId("timeline-toolbar").evaluate((el) => { el.scrollLeft = 0; });
  const controls = [
    ["view switcher", page.getByTestId("view-mode-toggle")],
    ["period nav", page.getByRole("button", { name: "Previous period" })],
    ["+ New", page.getByTestId("new-task-button")],
  ];
  for (const [name, locator] of controls) {
    const box = await locator.boundingBox();
    assert(box && box.width > 0, `${name} should have a bounding box`);
    assert(box.x >= -1, `${name} left edge should be in view (x=${box.x})`);
    assert(
      box.x + box.width <= vw + 1,
      `${name} right edge should be in view (right=${box.x + box.width}, viewport=${vw})`
    );
  }
  // The view switcher is the only path to Kanban/Calendar/List/Board on a phone.
  await page.getByTestId("view-mode-toggle").click();
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.press("Escape");
  await page
    .getByRole("menu")
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => undefined);
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

// A quick finger drag (well inside the hold window) must pan the timeline even
// when it starts on a task bar, instead of picking the task up.
// A task bar's position relative to the canvas content (client box plus the
// scroller offset). Panning the canvas leaves these unchanged; moving a task
// changes them.
async function readBarContentBoxes(page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    if (!body) return [];
    const b = body.getBoundingClientRect();
    return Array.from(document.querySelectorAll("[data-task-bar]")).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - b.left + body.scrollLeft,
        top: r.top - b.top + body.scrollTop,
      };
    });
  });
}

async function quickTouchDrag(page, context, locator, dx) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box && box.width > 0, "quick-drag target must have a bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  for (const step of [0.5, 1]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + dx * step, y, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(200);
}

// Hold past the pickup delay, then drag: the task must move and the long-press
// action bar must NOT open, because a deliberate move is a drag, not a menu.
async function holdThenDrag(page, context, locator, dx, dy) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box && box.width > 0, "hold-drag target must have a bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await page.waitForTimeout(520);
  for (const step of [0.5, 1]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + dx * step, y: y + dy * step, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(250);
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
  const newButton = page.getByTestId("new-task-button");
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

  console.log("[3a/7] toolbar keeps the view switcher and period nav in view");
  await dismissTour(page);
  await assertToolbarControlsInViewport(page);

  console.log("[3b/7] sections collapse to a rail and expand from the column");
  // Add a section from the view menu (phones keep the toolbar slim).
  await page.getByTestId("view-mode-toggle").click();
  await page.getByRole("menu").getByRole("button", { name: "Add section" }).click();
  // A phone defaults to the rail so the canvas keeps its width.
  const rail = page.locator('[data-section-rail="true"]').first();
  await rail.waitFor({ state: "visible", timeout: 10000 });
  const railBox = await rail.boundingBox();
  assert(
    railBox && railBox.width > 0 && railBox.width <= 48,
    `the section rail should be narrow (got ${railBox?.width})`
  );
  await assertToolbarControlsInViewport(page);
  // The `>` control at the top of the rail expands the full labels column.
  await page.getByTestId("expand-sections-rail").click();
  const expanded = page.locator('[data-section-rail="false"]').first();
  await expanded.waitFor({ state: "visible", timeout: 10000 });
  const expandedBox = await expanded.boundingBox();
  assert(
    expandedBox && expandedBox.width > 48,
    `expanded sections column should be wider than the rail (got ${expandedBox?.width})`
  );
  // The `<` control at the top of the expanded column collapses it again.
  await page.getByTestId("collapse-sections-rail").click();
  const railAgain = page.locator('[data-section-rail="true"]').first();
  await railAgain.waitFor({ state: "visible", timeout: 10000 });
  const railAgainBox = await railAgain.boundingBox();
  assert(
    railAgainBox && railAgainBox.width > 0 && railAgainBox.width <= 48,
    `the collapse control should restore the narrow rail (got ${railAgainBox?.width})`
  );

  console.log("[3c/7] a quick touch drag on a bar pans the timeline, not the task");
  await dismissTour(page);
  const barsBeforeQuickDrag = await readBarContentBoxes(page);
  const scrollBeforeQuickDrag = await page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    return body ? body.scrollLeft : null;
  });
  await quickTouchDrag(page, context, bar.first(), -100);
  const scrollAfterQuickDrag = await page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    return body ? body.scrollLeft : null;
  });
  const barsAfterQuickDrag = await readBarContentBoxes(page);
  assert(
    scrollBeforeQuickDrag !== null && scrollAfterQuickDrag !== null,
    "the timeline body should expose scrollLeft"
  );
  assert(
    scrollAfterQuickDrag !== scrollBeforeQuickDrag,
    `a quick touch drag must pan the timeline (scrollLeft ${scrollBeforeQuickDrag} -> ${scrollAfterQuickDrag})`
  );
  assert(
    barsBeforeQuickDrag.length > 0 && barsAfterQuickDrag.length === barsBeforeQuickDrag.length,
    `the task bar set must survive a pan (${barsBeforeQuickDrag.length} -> ${barsAfterQuickDrag.length})`
  );
  for (let i = 0; i < barsBeforeQuickDrag.length; i++) {
    const a = barsBeforeQuickDrag[i];
    const b = barsAfterQuickDrag[i];
    assert(
      Math.abs(a.left - b.left) <= 1 && Math.abs(a.top - b.top) <= 1,
      `a quick touch drag must not move the task (${JSON.stringify(a)} -> ${JSON.stringify(b)})`
    );
  }

  console.log("[4/7] long-press on the task bar opens the action bar (touch)");
  await dismissTour(page);
  await longPress(page, context, bar.first());
  await page.getByRole("button", { name: "Duplicate" }).waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("button", { name: "Done" }).waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("button", { name: "Close actions" }).click();
  await page
    .getByRole("button", { name: "Duplicate" })
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => undefined);

  console.log("[4b/7] a hold then drag moves the task without opening the action bar");
  await dismissTour(page);
  const holdBarsBefore = await readBarContentBoxes(page);
  // Move at least a day so the drop commits, and confirm the menu never appears.
  await holdThenDrag(page, context, bar.first(), -90, 0);
  const holdBarsAfter = await readBarContentBoxes(page);
  assert(
    JSON.stringify(holdBarsBefore) !== JSON.stringify(holdBarsAfter),
    `a hold then drag must move the task bar (${JSON.stringify(holdBarsBefore)} -> ${JSON.stringify(holdBarsAfter)})`
  );
  assert(
    !(await page
      .getByRole("button", { name: "Duplicate" })
      .isVisible()
      .catch(() => false)),
    "a hold then drag must not open the long-press action bar"
  );

  console.log("[5/7] AI drawer opens from the toolbar");
  await dismissTour(page);
  const aiButton = page.locator('button[aria-label="AI"]').first();
  await aiButton.waitFor({ state: "visible" });
  await aiButton.click();
  await page.getByText("AI Command").first().waitFor({ state: "visible", timeout: 10000 });
  // The open drawer covers its own toggle on mobile; close it with the header
  // close button (the real phone gesture).
  await page.getByRole("button", { name: "Close AI panel" }).click();
  await page.waitForTimeout(600);

  console.log("[6/7] settings: no horizontal overflow + mobile drawer entry");
  // Direct URL navigation to /settings bounces through the server auth check;
  // open it the way a phone user would. On a phone the gear lives in the view
  // menu (the toolbar keeps only the primary controls), so open that first.
  await dismissTour(page);
  await page.getByTestId("view-mode-toggle").click();
  await page.getByRole("button", { name: "Settings" }).click();
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
  console.log("\nSMOKE UI MOBILE PASS: register → tab bar → create task → long-press action bar → AI drawer → settings overflow → note drag");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});