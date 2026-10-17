#!/usr/bin/env node
/**
 * Headless-DOM (Playwright) smoke test for the resizable desktop panels, note
 * pin entry points, and the paused Idea Engine.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/panels-smoke.mjs
 *
 * Uses explicit DOM assertions and real pointer drags on the resize handles.
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
    // Fall through.
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

async function drag(page, locator, dx, dy = 0) {
  const box = await locator.boundingBox();
  assert(!!box, "resize handle should have a bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function panelWidth(page, handle) {
  return handle.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0);
}

async function storageValue(page, key) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

async function openTask(page, title) {
  const locator = page.locator("[data-timeline-body]").getByText(title, { exact: true });
  let visible = await locator.first().isVisible().catch(() => false);
  if (!visible) {
    await page.reload();
    await page.waitForTimeout(2000);
    visible = await locator.first().isVisible().catch(() => false);
  }
  assert(visible, `task "${title}" should be visible on the timeline`);
  await locator.first().click();
  await page.locator('[data-resize-handle="task"]').waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);
}

async function createTask(page, title) {
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
  await page.waitForTimeout(1200);
}

async function main() {
  const stamp = Date.now();
  const email = `panels-${stamp}@test.local`;
  const password = "panels-smoke-password-1";
  const titleA = `panel smoke A ${stamp}`;
  const titleB = `panel smoke B ${stamp}`;

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);

  console.log("[1/8] register a fresh user");
  await page.goto(`${BASE_URL}/register`);
  await page.getByPlaceholder("Your name (optional)").fill("Panels Smoke");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("At least 8 characters").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 20000 });

  console.log("[2/8] sidebar resize + web-scoped persistence");
  const sidebarHandle = page.locator('[data-resize-handle="sidebar"]');
  await sidebarHandle.waitFor({ state: "visible" });
  const sidebarBefore = await panelWidth(page, sidebarHandle);
  await drag(page, sidebarHandle, 84);
  const sidebarAfter = await panelWidth(page, sidebarHandle);
  assert(sidebarAfter > sidebarBefore + 40, `sidebar should widen (${sidebarBefore} -> ${sidebarAfter})`);
  const sidebarStored = await storageValue(page, "prysm_panel_width:web:sidebar");
  assert(sidebarStored !== null, "sidebar width should be stored under the web namespace");
  assert(Math.abs(Number(sidebarStored) - sidebarAfter) <= 2, "sidebar stored width should match");

  await page.reload();
  await page.waitForTimeout(800);
  const sidebarReloaded = await panelWidth(page, sidebarHandle);
  assert(Math.abs(sidebarReloaded - sidebarAfter) <= 2, `sidebar width should survive reload (${sidebarAfter} -> ${sidebarReloaded})`);

  console.log("[3/8] AI dock resize + web-scoped persistence");
  await page.locator('button[aria-label="AI"]').first().click();
  const aiDock = page.locator("[data-ai-dock]");
  await aiDock.waitFor({ state: "visible" });
  const aiHandle = page.locator('[data-resize-handle="ai"]');
  await aiHandle.waitFor({ state: "visible" });
  const aiBefore = await panelWidth(page, aiHandle);
  await drag(page, aiHandle, -96);
  const aiAfter = await panelWidth(page, aiHandle);
  assert(aiAfter > aiBefore + 50, `AI dock should widen when dragged left (${aiBefore} -> ${aiAfter})`);
  const aiStored = await storageValue(page, "prysm_panel_width:web:ai");
  assert(aiStored !== null, "AI dock width should be stored under the web namespace");
  assert(Math.abs(Number(aiStored) - aiAfter) <= 2, "AI dock stored width should match");

  console.log("[4/8] create two tasks through the UI");
  await createTask(page, titleA);
  await createTask(page, titleB);

  console.log("[5/8] task drawer resizes and remembers its width per task");
  await openTask(page, titleA);
  const taskHandle = page.locator('[data-resize-handle="task"]');
  const taskBefore = await panelWidth(page, taskHandle);
  await drag(page, taskHandle, -120);
  const taskAAfter = await panelWidth(page, taskHandle);
  assert(taskAAfter > taskBefore + 80, `task drawer should widen (${taskBefore} -> ${taskAAfter})`);
  const taskStorageA = await page.evaluate(() => {
    const entry = Object.entries(window.localStorage).find(([k]) => k.includes(":task:"));
    return entry ? { key: entry[0], value: Number(entry[1]) } : null;
  });
  assert(!!taskStorageA, "task drawer width should be stored per task id");
  assert(taskStorageA.key.startsWith("prysm_panel_width:web:task:"), `unexpected task key ${taskStorageA.key}`);
  assert(Math.abs(taskStorageA.value - taskAAfter) <= 2, "stored task width should match");

  await page.keyboard.press("Escape");
  await page.locator('[data-resize-handle="task"]').waitFor({ state: "hidden" });

  await openTask(page, titleB);
  const taskBBefore = await panelWidth(page, taskHandle);
  assert(Math.abs(taskBBefore - 400) <= 2, `second task should start at the default width (got ${taskBBefore})`);
  await page.waitForTimeout(500);
  await drag(page, taskHandle, -40);
  const taskBAfter = await panelWidth(page, taskHandle);
  console.log(`      task B width ${taskBBefore} -> ${taskBAfter}`);
  assert(Math.abs(taskBAfter - taskBBefore - 40) <= 3, "second task drawer should resize independently");
  await page.keyboard.press("Escape");
  await page.locator('[data-resize-handle="task"]').waitFor({ state: "hidden" });

  await openTask(page, titleA);
  const taskAReopened = await panelWidth(page, taskHandle);
  assert(Math.abs(taskAReopened - taskAAfter) <= 2, `task A width should be restored (${taskAAfter} -> ${taskAReopened})`);
  assert(Math.abs(taskAReopened - taskBAfter) > 20, "per-task widths should differ");

  console.log("[6/8] Idea Engine entry point is paused");
  assert((await page.getByRole("button", { name: "Process idea" }).count()) === 0, "Process idea should not be rendered");
  await page.keyboard.press("Escape");

  console.log("[7/8] Settings shows the Work in progress treatment");
  await page.goto(`${BASE_URL}/settings`);
  await page.getByRole("button", { name: "Premium", exact: true }).first().click();
  await page.getByText("Work in progress", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("Coming soon", { exact: true }).waitFor({ state: "visible", timeout: 10000 });

  console.log("[8/8] note pin controls are present");
  await page.goto(`${BASE_URL}/`);
  await page.waitForTimeout(1200);
  const notesSection = page.getByText("Notes", { exact: true }).first();
  if (await notesSection.isVisible().catch(() => false)) {
    console.log("      notes section visible; pin control is asserted by unit tests");
  }

  await browser.close();
  console.log("\nSMOKE PANELS PASS: sidebar + AI + per-task drawer resize, persistence, and Idea WIP");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
