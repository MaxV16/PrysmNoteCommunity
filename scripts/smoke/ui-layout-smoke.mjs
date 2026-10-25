#!/usr/bin/env node
/**
 * Phone layout regression smoke (Playwright, coordinate-free selectors only).
 *
 * Runs at the reported Android size (412x892, touch) and asserts the structural
 * fixes that are easy to regress:
 *   1. the page never scrolls horizontally
 *   2. the timeline toolbar fits without horizontal scrolling
 *   3. the New Task sheet is a single scroll region whose action bar is visible
 *      and clickable without scrolling first
 *   4. the view/overflow menu is fully inside the viewport and its last item is
 *      reachable (scrollable when tall)
 *   5. the left drawer stops above the bottom tab bar and does not cover it
 *   6. the AI panel is full-width (no sidebar rail bleeding through) and stops
 *      above the tab bar
 *   7. the task detail sheet stops above the tab bar, its footer is visible and
 *      its title is the first content block
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/ui-layout-smoke.mjs
 *   EXECUTABLE_PATH=... node scripts/smoke/ui-layout-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const VIEWPORT = { width: 412, height: 892 };

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
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 4000 });
    await gotIt.click();
  } catch {
    // Already dismissed (localStorage) or not shown yet.
  }
}

async function dismissTour(page) {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  } catch {
    // No tour is showing.
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const { scrollWidth, innerWidth, worst } = await page.evaluate(() => {
    const vw = window.innerWidth;
    let worstNode = null;
    let worstRight = vw;
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const right = r.right + window.scrollX;
      if (right > worstRight + 1) {
        worstRight = right;
        worstNode = `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")}`;
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: vw,
      worst: { right: worstRight, node: worstNode },
    };
  });
  assert(
    scrollWidth <= innerWidth + 1,
    `${label} should not scroll horizontally (scrollWidth=${scrollWidth}, viewport=${innerWidth}, widest=${worst.node} right=${worst.right})`
  );
}

async function boxOf(locator, label) {
  const box = await locator.boundingBox();
  assert(box, `${label} should have a bounding box`);
  return box;
}

function assertAboveTabBar(box, tabTop, label) {
  assert(
    box.y + box.height <= tabTop + 1,
    `${label} should stop above the tab bar (bottom=${box.y + box.height}, tabTop=${tabTop})`
  );
}

async function main() {
  const email = `uitest-layout-${Date.now()}@test.local`;
  const password = "ui-smoke-password-1";
  const title = `layout smoke ${Date.now()}`;

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  console.log("[1/7] register a fresh user at 412x892");
  await page.goto(`${BASE_URL}/register`);
  await dismissCookieBanner(page);
  await page.getByPlaceholder("Your name (optional)").fill("Layout Smoke");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("At least 8 characters").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 25000 });

  const tabBar = page.locator('nav[aria-label="Primary"]');
  await tabBar.waitFor({ state: "visible", timeout: 20000 });
  const tabBox = await boxOf(tabBar, "bottom tab bar");
  const tabTop = tabBox.y;

  console.log("[2/7] the page and toolbar fit the phone width");
  await dismissCookieBanner(page);
  await dismissTour(page);
  await assertNoHorizontalOverflow(page, "the app shell");
  const toolbarFits = await page.getByTestId("timeline-toolbar").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  assert(
    toolbarFits.scrollWidth <= toolbarFits.clientWidth + 1,
    `the timeline toolbar should not need horizontal scrolling (scrollWidth=${toolbarFits.scrollWidth}, client=${toolbarFits.clientWidth})`
  );
  // The timeline zoom control exists and the compact view menu exposes it on a
  // phone (the inline segmented control is desktop-only).
  assert(
    (await page.getByTestId("timeline-zoom").count()) >= 1,
    "the timeline zoom control should be mounted"
  );

  console.log("[3/7] New Task sheet: one scroll region, visible action bar");
  await page.getByTestId("new-task-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  const createButton = page.getByRole("button", { name: "Create Task" });
  await createButton.waitFor({ state: "visible", timeout: 5000 });
  // Visible WITHOUT scrolling the sheet first.
  const createBox = await boxOf(createButton, "Create Task button");
  assert(
    createBox.y >= 0 && createBox.y + createBox.height <= VIEWPORT.height + 1,
    `Create Task should be in view before scrolling (y=${createBox.y}, bottom=${createBox.y + createBox.height})`
  );
  // The form itself must not have its own nested scrollbar (the sheet body owns
  // the only scroll), which was the "buttons over a second scroll" defect.
  // A form that is taller than the sheet is fine: the sheet body scrolls it.
  // What must never happen is the form declaring its own scroll container,
  // which produced the "buttons over a second scroll" defect.
  const nestedScrollers = await page
    .locator('[data-testid="task-form"]')
    .evaluate((form) => {
      const offenders = [];
      for (const el of [form, ...form.querySelectorAll("*")]) {
        // Textareas scroll their own editable text by nature; that is not the
        // "second scroll region" defect (which was a wrapping div).
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") continue;
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          offenders.push(`${el.tagName.toLowerCase()}:${overflowY}`);
        }
      }
      return offenders;
    });
  assert(
    nestedScrollers.length === 0,
    `the task form should not add a second scroll area (${nestedScrollers.join(", ")})`
  );
  await page.getByPlaceholder("What needs to be done?").fill(title);
  await createButton.click();
  await dialog.waitFor({ state: "hidden", timeout: 15000 }).catch(() => undefined);
  const bar = page.locator("[data-task-bar]", { hasText: title }).first();
  await bar.waitFor({ state: "visible", timeout: 15000 });

  console.log("[4/7] view menu stays inside the viewport and is reachable");
  await dismissTour(page);
  await page.getByTestId("view-mode-toggle").click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 5000 });
  const menuBox = await boxOf(menu, "view menu");
  assert(menuBox.x >= -1, `menu left edge should be in view (x=${menuBox.x})`);
  assert(
    menuBox.x + menuBox.width <= VIEWPORT.width + 1,
    `menu right edge should be in view (right=${menuBox.x + menuBox.width})`
  );
  assert(menuBox.y >= -1, `menu top edge should be in view (y=${menuBox.y})`);
  assert(
    menuBox.y + menuBox.height <= VIEWPORT.height + 1,
    `menu bottom edge should be in view (bottom=${menuBox.y + menuBox.height})`
  );
  const menuZoom = page.getByTestId("view-menu-zoom-level");
  await menuZoom.waitFor({ state: "visible", timeout: 5000 });
  assert(
    /^\d+%$/.test((await menuZoom.textContent())?.trim() ?? ""),
    "the view menu should show the current timeline zoom percentage"
  );
  const lastItem = menu.getByRole("button").last();
  await lastItem.scrollIntoViewIfNeeded();
  const lastBox = await boxOf(lastItem, "last menu item");
  assert(
    lastBox.y + lastBox.height <= VIEWPORT.height + 1,
    `the last menu item should be reachable (bottom=${lastBox.y + lastBox.height})`
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);

  console.log("[5/7] left drawer stops above the bottom tab bar");
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.locator('[data-variant="drawer"]');
  await drawer.waitFor({ state: "visible", timeout: 5000 });
  const drawerBox = await boxOf(drawer, "sidebar drawer");
  assert(drawerBox.width > 0 && drawerBox.width <= VIEWPORT.width, "the drawer should fit the viewport width");
  assertAboveTabBar(drawerBox, tabTop, "the sidebar drawer");
  // The account row is the last block of the drawer and must be on screen.
  const account = drawer.getByRole("button", { name: /Layout Smoke/ }).first();
  await account.scrollIntoViewIfNeeded();
  const accountBox = await boxOf(account, "drawer account row");
  assertAboveTabBar(accountBox, tabTop, "the drawer account row");
  await drawer.getByRole("button", { name: "Close menu" }).click();
  await drawer.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);

  console.log("[6/7] AI panel is full width and does not bleed the sidebar");
  await page.locator('[data-tour="ai-panel"]').click();
  const aiDock = page.locator("[data-ai-dock]");
  await aiDock.waitFor({ state: "visible", timeout: 10000 });
  const aiBox = await boxOf(aiDock, "AI panel");
  assert(aiBox.x <= 1, `the AI panel should start at the left edge (x=${aiBox.x})`);
  assert(
    aiBox.x + aiBox.width >= VIEWPORT.width - 1,
    `the AI panel should span the full width (right=${aiBox.x + aiBox.width}, viewport=${VIEWPORT.width})`
  );
  assertAboveTabBar(aiBox, tabTop, "the AI panel");
  assert((await drawer.count()) === 0, "the sidebar drawer must stay closed behind the AI panel");
  await assertNoHorizontalOverflow(page, "the AI panel");
  await page.getByRole("button", { name: "Close AI panel" }).click();
  await aiDock.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);

  console.log("[7/7] task sheet stops above the tab bar with a visible footer");
  await bar.click();
  const sheetFooter = page.getByTestId("task-drawer-actions");
  await sheetFooter.waitFor({ state: "visible", timeout: 10000 });
  const sheetBox = await boxOf(page.getByTestId("task-drawer"), "task sheet");
  assertAboveTabBar(sheetBox, tabTop, "the task sheet");
  const footerBox = await boxOf(sheetFooter, "task sheet footer");
  assert(
    footerBox.y + footerBox.height <= VIEWPORT.height + 1,
    `the task sheet footer should be on screen (bottom=${footerBox.y + footerBox.height})`
  );
  // The title must be the first content block, above the reminder row.
  const titleBox = await boxOf(page.getByRole("heading", { name: title }), "task title");
  const remindBox = await boxOf(page.getByRole("button", { name: "Set task reminder" }), "reminder row");
  assert(
    titleBox.y < remindBox.y,
    `the title should sit above the reminder row (title=${titleBox.y}, reminder=${remindBox.y})`
  );
  await assertNoHorizontalOverflow(page, "the task sheet");

  await browser.close();
  console.log(
    "\nSMOKE UI LAYOUT PASS: no h-overflow → toolbar fits → new-task footer → view menu → drawer → AI pane → task sheet"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
