#!/usr/bin/env node
/**
 * Playwright smoke for the custom timeline drag engine.
 *
 * Deterministic UI-truth channel: creates a task, drags its bar exactly one day
 * to the right, then asserts both the rendered bar moved by exactly one day
 * width AND the persisted start_date advanced by one day.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/timeline-drag-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_URL = process.env.API_URL || "http://localhost:8000/api";

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
    // Fall through to system browsers.
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

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function dismissTour(page) {
  const tour = page.getByRole("dialog", { name: "Welcome to Prysm Note" });
  await tour.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  let quiet = 0;
  for (let i = 0; i < 60 && quiet < 12; i++) {
    if (await tour.isVisible().catch(() => false)) {
      quiet = 0;
      const skip = page.getByRole("button", { name: /^Skip$/ }).first();
      if (await skip.isVisible().catch(() => false)) {
        await skip.click({ force: true }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    } else {
      quiet += 1;
    }
    await page.waitForTimeout(200);
  }
  return !(await tour.isVisible().catch(() => false));
}

/**
 * The drag engine auto-scrolls the canvas when the pointer enters an edge zone.
 * These gestures are about the pointer math, not auto-scroll, so recenter the
 * canvas until the bar sits comfortably between both edge zones (each is at
 * most 180px wide) with room for the one-day drag plus the fractional nudge.
 */
async function ensureBarClearOfEdges(page) {
  const geom = await page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    const bar = document.querySelector("[data-task-bar]");
    if (!body || !bar) return null;
    const b = body.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    return {
      bodyLeft: b.left,
      bodyRight: b.right,
      bodyWidth: body.clientWidth,
      center: r.left + r.width / 2,
    };
  });
  if (!geom) return;
  const edgeZone = Math.min(180, Math.max(64, geom.bodyWidth * 0.2));
  const maxCenter = geom.bodyRight - edgeZone - 300;
  const minCenter = geom.bodyLeft + edgeZone + 80;
  // Increasing scrollLeft moves the bar left on screen, and vice versa.
  let scrollBy = 0;
  if (geom.center > maxCenter) scrollBy = geom.center - maxCenter;
  else if (geom.center < minCenter) scrollBy = -(minCenter - geom.center);
  if (scrollBy === 0) return;
  await page.evaluate((d) => {
    const body = document.querySelector("[data-timeline-body]");
    if (body) body.scrollLeft += d;
  }, scrollBy);
  await page.waitForTimeout(250);
}

async function main() {
  const email = `dragtest-${Date.now()}@test.local`;
  const password = "drag-smoke-password-1";
  const title = `drag smoke ${Date.now()}`;

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage();
  // A wide desktop viewport so the bar parked a few days into the canvas is
  // comfortably inside the visible area for the pointer drag.
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.setDefaultTimeout(15000);

  try {
    console.log("[1/8] register a fresh user");
    await page.goto(`${BASE_URL}/register`);
    await page.getByPlaceholder("Your name (optional)").fill("Drag Smoke");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("At least 8 characters").fill(password);
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 20000 });
    await page.waitForSelector("[data-timeline-body]");
    assert(await dismissTour(page), "the first-run tour could not be dismissed");

    console.log("[2/8] add a timeline section to drag a task into");
    // Scope to the timeline toolbar: the left labels column also has an
    // "Add section" control once sections exist.
    await page
      .getByTestId("timeline-toolbar")
      .getByRole("button", { name: "Add section" })
      .click();
    await page
      .locator('[data-timeline-lane][data-lane-section-id]:not([data-lane-section-id=""])')
      .first()
      .waitFor({ state: "visible", timeout: 10000 });

    console.log("[3/8] create a task dated today");
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
    // Target the bar element itself (not the title span) so the pointer lands on
    // a real, hit-testable part of the bar.
    const bar = page.locator("[data-task-bar]", { hasText: title }).first();
    await bar.waitFor({ state: "visible", timeout: 20000 });

    console.log("[4/8] measure the bar and the day-column width");
    const dayWidth = await page.evaluate(() => {
      const col = document.querySelector("[data-day-column]");
      return col ? col.getBoundingClientRect().width : 0;
    });
    assert(dayWidth > 0, "could not measure the day-column width");
    await ensureBarClearOfEdges(page);
    const before = await bar.boundingBox();
    assert(before && before.width > 0, "task bar should have a rendered box");

    console.log("[5/8] drag the bar exactly one day to the right");
    const startX = before.x + before.width / 2;
    const startY = before.y + before.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // A couple of frames of movement so the engine activates and RAFs.
    await page.mouse.move(startX + dayWidth * 0.5, startY, { steps: 6 });
    await page.waitForTimeout(60);
    await page.mouse.move(startX + dayWidth, startY, { steps: 6 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(900);

    console.log("[6/8] assert the bar moved one day and the date persisted");
    const after = await bar.boundingBox();
    assert(after, "task bar should still be rendered after the drag");
    const movedPx = after.x - before.x;
    assert(
      Math.abs(movedPx - dayWidth) <= 6,
      `bar should move exactly one day (${dayWidth}px); moved ${movedPx.toFixed(1)}px`
    );

    // A drop still emits a browser click on the bar; that click must be
    // suppressed or the task details open over the timeline and swallow the
    // next gesture.
    const overlay = await page.evaluate(() => {
      const bar = document.querySelector("[data-task-bar]");
      if (!bar) return { covered: "no-bar" };
      const r = bar.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { covered: !(at && (at === bar || bar.contains(at))) };
    });
    assert(
      overlay.covered === false,
      "a dropped task must not open its details over the timeline (drag click not suppressed)"
    );

    const expected = isoDaysFromNow(1);
    const apiRes = await page.request.get(`${API_URL}/tasks/`);
    assert(apiRes.ok(), `task list request failed with HTTP ${apiRes.status()}`);
    const allTasks = await apiRes.json();
    const persisted = Array.isArray(allTasks)
      ? allTasks.find((task) => task.title === title)
      : null;
    assert(persisted, "the dragged task should still exist");
    assert(
      persisted.start_date === expected,
      `start_date should be ${expected} after a one-day drag, got ${persisted.start_date}`
    );

    // Regression: the drag preview must follow the pointer continuously (a
    // fraction of a day moves the bar that fraction), and a nudge shorter than
    // half a day must be a no-op. The old engine snapped the preview to whole
    // days at the first pixel of movement, so this bar would leap a full column
    // the moment the pointer left the activation threshold.
    console.log("[7/8] drag a third of a day: preview tracks the pointer, drop is a no-op");
    await ensureBarClearOfEdges(page);
    const nudgeStart = await bar.boundingBox();
    assert(nudgeStart, "task bar should have a rendered box before the nudge");
    const nudgeX = nudgeStart.x + nudgeStart.width / 2;
    const nudgeY = nudgeStart.y + nudgeStart.height / 2;
    const partial = dayWidth * 0.35;
    await page.mouse.move(nudgeX, nudgeY);
    await page.mouse.down();
    await page.mouse.move(nudgeX + partial, nudgeY, { steps: 8 });
    await page.waitForTimeout(80);
    const midDrag = await bar.boundingBox();
    assert(midDrag, "task bar should still be rendered mid-drag");
    const previewPx = midDrag.x - nudgeStart.x;
    assert(
      Math.abs(previewPx - partial) <= 4,
      `preview should track the pointer continuously at ${partial.toFixed(1)}px; got ${previewPx.toFixed(1)}px (snapped)`
    );
    await page.mouse.up();
    await page.waitForTimeout(900);

    const settled = await bar.boundingBox();
    assert(settled, "task bar should still be rendered after the nudge");
    assert(
      Math.abs(settled.x - nudgeStart.x) <= 4,
      `a sub-half-day nudge must not move the task; bar jumped ${(settled.x - nudgeStart.x).toFixed(1)}px`
    );
    const nudgeRes = await page.request.get(`${API_URL}/tasks/`);
    assert(nudgeRes.ok(), `task list request failed with HTTP ${nudgeRes.status()}`);
    const nudgeTasks = await nudgeRes.json();
    const nudgePersisted = Array.isArray(nudgeTasks)
      ? nudgeTasks.find((task) => task.title === title)
      : null;
    assert(nudgePersisted, "the nudged task should still exist");
    assert(
      nudgePersisted.start_date === expected,
      `a sub-half-day nudge must not change start_date; expected ${expected}, got ${nudgePersisted.start_date}`
    );

    // Vertical dragging: the bar follows the pointer on the Y axis and the lane
    // it is dropped on supplies the section, independently of the day.
    console.log("[8/8] drag the bar vertically into the section lane");
    const geom = await page.evaluate(() => {
      const lane = document.querySelector(
        '[data-timeline-lane][data-lane-section-id]:not([data-lane-section-id=""])'
      );
      const bar = document.querySelector("[data-task-bar]");
      if (!lane || !bar) return null;
      const l = lane.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return {
        sectionId: lane.getAttribute("data-lane-section-id"),
        laneTop: l.top,
        laneBottom: l.bottom,
        laneMid: l.top + l.height / 2,
        barMidY: b.top + b.height / 2,
        barMidX: b.left + b.width / 2,
      };
    });
    assert(geom && geom.sectionId, "the timeline section lane should be present");
    assert(
      geom.barMidY > geom.laneBottom,
      "the unsorted task bar should start below the section lane"
    );

    const dateBeforeVertical = nudgePersisted.start_date;
    await page.mouse.move(geom.barMidX, geom.barMidY);
    await page.mouse.down();
    // Vertical-only gesture: a 1px x nudge activates the drag without asking
    // for a day change.
    await page.mouse.move(geom.barMidX + 1, (geom.barMidY + geom.laneMid) / 2, { steps: 8 });
    await page.waitForTimeout(60);
    await page.mouse.move(geom.barMidX + 1, geom.laneMid, { steps: 8 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(900);

    const laneBox = await page
      .locator(`[data-timeline-lane][data-lane-section-id="${geom.sectionId}"]`)
      .boundingBox();
    const droppedBox = await bar.boundingBox();
    assert(laneBox && droppedBox, "the bar and its destination lane should be rendered");
    assert(
      droppedBox.y >= laneBox.y - 2 &&
        droppedBox.y + droppedBox.height <= laneBox.y + laneBox.height + 2,
      "the bar should render inside the section lane after a vertical drag"
    );

    const sectionRes = await page.request.get(`${API_URL}/tasks/`);
    assert(sectionRes.ok(), `task list request failed with HTTP ${sectionRes.status()}`);
    const sectionTasks = await sectionRes.json();
    const movedTask = Array.isArray(sectionTasks)
      ? sectionTasks.find((task) => task.title === title)
      : null;
    assert(movedTask, "the vertically dragged task should still exist");
    assert(
      movedTask.board_section_id === geom.sectionId,
      `board_section_id should be ${geom.sectionId} after a vertical drag, got ${movedTask.board_section_id}`
    );
    assert(
      movedTask.start_date === dateBeforeVertical,
      `a vertical drag must not change the date; expected ${dateBeforeVertical}, got ${movedTask.start_date}`
    );

    await browser.close();
    console.log(
      "\nSMOKE TIMELINE DRAG PASS: one-day drag persisted, fractional preview tracked the pointer, sub-half-day nudge was a no-op, vertical drag moved the task into the section lane"
    );
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
