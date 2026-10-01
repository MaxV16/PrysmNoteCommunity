#!/usr/bin/env node
/**
 * Playwright smoke for two-axis drag-to-pan on the timeline canvas.
 *
 * Deterministic UI-truth channel: with the canvas overflowing vertically, a
 * vertical-only drag on empty canvas must move `scrollTop`, a horizontal-only
 * drag must move `scrollLeft`, and a diagonal drag must move both. The left
 * labels column must track the body, a vertical pan must not rebuild the
 * rendered day slice, and a pan must never drag a task.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/timeline-pan-smoke.mjs
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

async function readScroll(page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    if (!body) return null;
    return {
      scrollLeft: body.scrollLeft,
      scrollTop: body.scrollTop,
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      range: body.getAttribute("data-timeline-range"),
    };
  });
}

async function readLabelsScrollTop(page) {
  return page.evaluate(() => {
    const col = document.querySelector("[data-section-rail]");
    return col ? col.scrollTop : null;
  });
}

/**
 * Task bars are children of the scrolled canvas, so a pan moves their client
 * box with the content. Record their CONTENT-relative position (client box plus
 * the scroller's offset) and whether any imperative drag preview was applied:
 * a pan must leave both untouched.
 */
async function readBarState(page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    if (!body) return [];
    const b = body.getBoundingClientRect();
    return Array.from(document.querySelectorAll("[data-task-bar]")).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - b.left + body.scrollLeft,
        top: r.top - b.top + body.scrollTop,
        width: r.width,
        transform: el.style.transform,
      };
    });
  });
}

async function addSectionsUntilOverflow(page, max) {
  const toolbar = page.getByTestId("timeline-toolbar");
  let added = 0;
  while (added < max) {
    const info = await readScroll(page);
    if (info && info.scrollHeight > info.clientHeight + 400) break;
    const beforeCount = await page.locator("[data-timeline-lane]").count();
    await toolbar.getByRole("button", { name: "Add section" }).click();
    added += 1;
    await page
      .locator("[data-timeline-lane]")
      .nth(beforeCount)
      .waitFor({ state: "attached", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(80);
  }
  return added;
}

async function gesture(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  // Let the labels-column sync RAF land before reading the final offsets.
  await page.waitForTimeout(150);
}

async function setScroll(page, scrollLeft, scrollTop) {
  await page.evaluate(
    ({ left, top }) => {
      const body = document.querySelector("[data-timeline-body]");
      if (!body) return;
      if (left !== null) body.scrollLeft = left;
      if (top !== null) body.scrollTop = top;
    },
    { left: scrollLeft, top: scrollTop }
  );
  await page.waitForTimeout(150);
}

async function main() {
  const email = `pansmoke-${Date.now()}@test.local`;
  const password = "pan-smoke-password-1";
  const title = `pan smoke ${Date.now()}`;

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.setDefaultTimeout(20000);

  try {
    console.log("[1/7] register a fresh user");
    await page.goto(`${BASE_URL}/register`);
    await page.getByPlaceholder("Your name (optional)").fill("Pan Smoke");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("At least 8 characters").fill(password);
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 20000 });
    await page.waitForSelector("[data-timeline-body]");
    assert(await dismissTour(page), "the first-run tour could not be dismissed");

    console.log("[2/7] add sections until the canvas overflows vertically");
    const added = await addSectionsUntilOverflow(page, 45);
    const overflow = await readScroll(page);
    assert(overflow, "the timeline body should exist");
    assert(
      overflow.scrollHeight > overflow.clientHeight + 1,
      `the canvas must overflow vertically for this smoke; added ${added} sections`
    );

    console.log("[3/7] create a task so a real bar is on the canvas");
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
    await page
      .locator("[data-task-bar]", { hasText: title })
      .first()
      .waitFor({ state: "visible", timeout: 20000 });

    const geom = await page.evaluate(() => {
      const body = document.querySelector("[data-timeline-body]");
      const r = body.getBoundingClientRect();
      return { left: r.left, top: r.top, scrollLeft: body.scrollLeft };
    });
    // Empty canvas: the sticky day-header row, above every lane and bar.
    const x = geom.left + 220;
    const yHeader = geom.top + 25;
    // Keep the canvas near today so the task's day stays inside the bounded
    // rendered slice for the whole run (bars outside the slice unmount).
    const homeLeft = geom.scrollLeft;

    console.log("[4/7] horizontal-only drag moves scrollLeft only, with no fling");
    await setScroll(page, homeLeft, 0);
    const hBefore = await readScroll(page);
    await gesture(page, { x, y: yHeader }, { x: x + 150, y: yHeader });
    const hAfter = await readScroll(page);
    assert(hAfter.scrollLeft !== hBefore.scrollLeft, "a horizontal drag must move scrollLeft");
    assert(
      hAfter.scrollTop === hBefore.scrollTop,
      `a horizontal-only drag must not move scrollTop (${hBefore.scrollTop} -> ${hAfter.scrollTop})`
    );

    // A fast flick must pan while held and then stop dead on release: there is
    // no momentum, so the position at release is where it stays.
    await page.mouse.move(x, yHeader);
    await page.mouse.down();
    await page.mouse.move(x + 260, yHeader, { steps: 2 });
    await page.mouse.up();
    const flingAtRelease = await readScroll(page);
    await page.waitForTimeout(600);
    const flingAfter = await readScroll(page);
    assert(
      flingAtRelease.scrollLeft !== hAfter.scrollLeft,
      "a fast flick must still pan the canvas while held"
    );
    assert(
      flingAfter.scrollLeft === flingAtRelease.scrollLeft &&
        flingAfter.scrollTop === flingAtRelease.scrollTop,
      `a released pan must not fling (${flingAtRelease.scrollLeft} -> ${flingAfter.scrollLeft})`
    );

    console.log("[5/7] diagonal drag moves both axes");
    await setScroll(page, homeLeft, 0);
    const dBefore = await readScroll(page);
    await gesture(page, { x, y: yHeader }, { x: x + 120, y: yHeader - 160 });
    const dAfter = await readScroll(page);
    assert(dAfter.scrollLeft < dBefore.scrollLeft, "a diagonal drag must move scrollLeft");
    assert(dAfter.scrollTop > dBefore.scrollTop, "a diagonal drag must move scrollTop");

    console.log("[6/7] vertical-only drag pans while held and tracks the labels column");
    await setScroll(page, homeLeft, 0);
    const vBefore = await readScroll(page);
    const barsBefore = await readBarState(page);
    await page.mouse.move(x, yHeader);
    await page.mouse.down();
    await page.mouse.move(x, yHeader - 80, { steps: 6 });
    await page.waitForTimeout(60);
    // While held, the pan writes real scroll offsets straight from the pointer
    // event. The rendered slice must NOT carry a transform: forcing one on the
    // whole slice builds an enormous compositor layer and janks the pan.
    const midDrag = await page.evaluate(() => {
      const body = document.querySelector("[data-timeline-body]");
      const slice = body?.firstElementChild?.firstElementChild ?? null;
      return {
        scrollTop: body ? body.scrollTop : -1,
        sliceTransform: slice ? slice.style.transform : null,
        bodyTransform: body ? body.style.transform : "",
      };
    });
    await page.mouse.move(x, yHeader - 150, { steps: 6 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const vAfter = await readScroll(page);
    const barsAfter = await readBarState(page);
    const labelsAfter = await readLabelsScrollTop(page);

    assert(
      midDrag.scrollTop > vBefore.scrollTop,
      `a held pan must move scrollTop while held (${vBefore.scrollTop} -> ${midDrag.scrollTop})`
    );
    assert(
      !midDrag.sliceTransform,
      `the rendered slice must not be transformed (got ${midDrag.sliceTransform})`
    );
    assert(
      !midDrag.bodyTransform,
      `the scroll container must not be transformed (got ${midDrag.bodyTransform})`
    );
    assert(
      vAfter.scrollTop > vBefore.scrollTop,
      `a vertical-only drag must move scrollTop (${vBefore.scrollTop} -> ${vAfter.scrollTop})`
    );
    assert(
      vAfter.scrollLeft === vBefore.scrollLeft,
      `a vertical-only drag must not move scrollLeft (${vBefore.scrollLeft} -> ${vAfter.scrollLeft})`
    );
    assert(
      vAfter.range === vBefore.range,
      `a vertical pan must not rebuild the day slice (${vBefore.range} -> ${vAfter.range})`
    );
    assert(labelsAfter !== null, "the section labels column should be present");
    assert(
      labelsAfter === vAfter.scrollTop,
      `the labels column must track the body scrollTop (labels ${labelsAfter}, body ${vAfter.scrollTop})`
    );

    assert(
      barsBefore.length > 0 && barsAfter.length === barsBefore.length,
      `the task bar set must be stable across a pan (${barsBefore.length} -> ${barsAfter.length})`
    );
    for (let i = 0; i < barsBefore.length; i++) {
      const a = barsBefore[i];
      const b = barsAfter[i];
      assert(
        Math.abs(a.left - b.left) <= 1 &&
          Math.abs(a.top - b.top) <= 1 &&
          Math.abs(a.width - b.width) <= 1,
        `a pan must not drag a task: bar ${i} moved (${JSON.stringify(a)} -> ${JSON.stringify(b)})`
      );
      assert(b.transform === "", `a pan must not apply a drag preview to bar ${i}`);
    }

    console.log("[7/7] persisted task is untouched by the pan");
    const res = await page.request.get(`${API_URL}/tasks/`);
    assert(res.ok(), `task list request failed with HTTP ${res.status()}`);
    const tasks = await res.json();
    const persisted = Array.isArray(tasks) ? tasks.find((t) => t.title === title) : null;
    assert(persisted, "the task should still exist after panning");

    await browser.close();
    console.log(
      "\nSMOKE TIMELINE PAN PASS: vertical, horizontal and diagonal drags pan the canvas, the labels column tracks, the day slice is stable, and no task is dragged"
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
