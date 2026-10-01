#!/usr/bin/env node
// Touch drag/pan contract for the timeline:
//  1. Phone: a long hold then drag moves the task and never scrolls the canvas
//     (the task stays under the finger, even near an edge), and the action menu
//     does not appear.
//  2. Phone: a stationary long hold opens the action menu.
//  3. Wide window (touchscreen): the same single hold contract applies, so a
//     held drag moves the task and never scrolls the canvas.
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
      if (dir.startsWith("chromium_headless_shell-")) {
        const p = `${cacheRoot}/${dir}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return "";
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function dismissTour(page) {
  const tour = page.getByRole("dialog", { name: "Welcome to Prysm Note" });
  await tour.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  for (let i = 0; i < 40 && (await tour.isVisible().catch(() => false)); i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(100);
  }
}

async function createTask(page, title) {
  const newButton = page.getByTestId("new-task-button");
  await newButton.waitFor({ state: "visible", timeout: 15000 });
  await newButton.click();
  await page.getByText("Task Title").waitFor({ state: "visible" });
  await page.getByPlaceholder("What needs to be done?").fill(title);
  await page.getByRole("button", { name: "Create Task" }).click();
  await page.getByText("Task Title").waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
  await page
    .locator("[data-task-bar]", { hasText: title })
    .first()
    .waitFor({ state: "visible", timeout: 20000 });
}

async function runScenario(browser, { wide, hold, dragDx }) {
  const email = `touch-${wide ? "wide" : "phone"}-${Date.now()}@test.local`;
  const context = await browser.newContext({
    viewport: wide ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    hasTouch: true,
    isMobile: !wide,
    deviceScaleFactor: wide ? 1 : 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);

  const reg = await context.request.post(`${API_URL}/auth/register`, {
    data: { email, password: "touch-password-1", display_name: "Touch Smoke" },
  });
  assert(reg.status() === 200, `register failed with ${reg.status()}`);

  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector("[data-timeline-body]", { timeout: 25000 });
  await dismissTour(page);

  for (const t of ["alpha task", "beta task", "gamma task"]) await createTask(page, t);
  await page.waitForTimeout(400);

  const geom = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll("[data-task-bar]")).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-task-id"), x: r.x, y: r.y, w: r.width, h: r.height };
    });
    list.sort((a, b) => a.y - b.y);
    return { bars: list };
  });
  assert(geom.bars.length >= 1, "no task bars rendered");
  // The first task in the section is the topmost bar.
  const target = geom.bars[0];

  await page.evaluate((id) => {
    const el = document.querySelector(`[data-task-bar][data-task-id="${id}"]`);
    el?.scrollIntoView({ block: "center", inline: "center" });
  }, target.id);
  await page.waitForTimeout(300);
  const box = await page.locator(`[data-task-bar][data-task-id="${target.id}"]`).boundingBox();
  assert(box, "target bar has no box");

  await page.evaluate(() => {
    window.__samples = [];
    const body = document.querySelector("[data-timeline-body]");
    const t = () => Math.round(performance.now());
    window.addEventListener(
      "pointercancel",
      () => window.__samples.push({ k: "cancel", t: t() }),
      true
    );
    const sample = () => {
      const el = document.querySelector(
        "[data-task-bar][data-task-id='" + window.__targetId + "']"
      );
      window.__samples.push({
        k: "raf",
        sl: Math.round(body.scrollLeft),
        st: Math.round(body.scrollTop),
        tr: el ? el.style.transform : "",
      });
      window.__raf = requestAnimationFrame(sample);
    };
    window.__targetId = "";
    window.__raf = requestAnimationFrame(sample);
  });
  await page.evaluate((id) => (window.__targetId = id), target.id);

  const cdp = await context.newCDPSession(page);
  const cx = Math.round(box.x + Math.min(box.width / 2, 60));
  const cy = Math.round(box.y + box.height / 2);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: cx, y: cy, radiusX: 2, radiusY: 2, force: 1 }],
  });

  if (hold) {
    // A real finger wobbles while holding.
    for (const [jx, jy] of [
      [cx + 3, cy + 1],
      [cx + 1, cy + 3],
      [cx + 4, cy + 2],
    ]) {
      await page.waitForTimeout(120);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: jx, y: jy, radiusX: 2, radiusY: 2, force: 1 }],
      });
    }
    await page.waitForTimeout(250);
  }

  if (dragDx !== 0) {
    for (const step of [0.4, 0.7, 1.0]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: Math.max(1, Math.round(cx - dragDx * step)), y: cy, radiusX: 2, radiusY: 2, force: 1 },
        ],
      });
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(120);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(400);

  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__samples;
  });
  const menuVisible = await page
    .getByRole("button", { name: "Duplicate" })
    .isVisible()
    .catch(() => false);

  const raf = samples.filter((s) => s.k === "raf");
  const cancels = samples.filter((s) => s.k === "cancel").length;
  const slMin = Math.min(...raf.map((s) => s.sl));
  const slMax = Math.max(...raf.map((s) => s.sl));
  const moved = raf.reduce((max, s) => {
    const m = /translate3d\((-?\d+(?:\.\d+)?)px/.exec(s.tr || "");
    return m ? Math.max(max, Math.abs(Number(m[1]))) : max;
  }, 0);

  await context.close();
  return { moved, scrollMoved: slMin !== slMax, cancels, menuVisible, label: wide ? "wide" : "phone" };
}

async function main() {
  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  try {
    const drag = await runScenario(browser, { wide: false, hold: true, dragDx: 150 });
    console.log("phone hold-drag:", JSON.stringify(drag));
    assert(drag.cancels === 0, "phone hold-drag emitted pointercancel");
    assert(drag.moved >= 100, `phone hold-drag did not move the task (moved ${drag.moved}px)`);
    assert(!drag.scrollMoved, "phone hold-drag scrolled the canvas instead of moving the task");
    assert(!drag.menuVisible, "phone hold-drag also opened the action menu");

    const hold = await runScenario(browser, { wide: false, hold: true, dragDx: 0 });
    console.log("phone stationary hold:", JSON.stringify(hold));
    assert(hold.menuVisible, "phone stationary hold did not open the action menu");
    // Finger jitter during the hold is expected; it must stay under the
    // deliberate-move threshold that would cancel the menu.
    assert(hold.moved < 8, `phone stationary hold moved the task (moved ${hold.moved}px)`);

    const wide = await runScenario(browser, { wide: true, hold: true, dragDx: 150 });
    console.log("wide touch hold-drag:", JSON.stringify(wide));
    assert(wide.moved >= 100, `wide touch hold-drag did not move the task (moved ${wide.moved}px)`);
    assert(!wide.scrollMoved, "wide touch drag scrolled the canvas instead of moving the task");
  } finally {
    await browser.close();
  }
  console.log("PASS timeline-touch-smoke");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
