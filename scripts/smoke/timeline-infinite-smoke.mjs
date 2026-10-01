#!/usr/bin/env node
/**
 * Headless-DOM smoke test for the timeline canvas.
 *
 * Guards two regressions that made the timeline "stop":
 *  1. a mount-expansion cap ended the canvas at today + 99 days (Dec 24 when
 *     today is Sep 16), so scrolling could not pass that date;
 *  2. a sliding-window trim rewrote scrollLeft, so with real scrolling the dates
 *     jumped backwards and the position reset.
 *
 * The canvas is now a fixed, very wide day strip: scrollLeft maps directly to a
 * date, the extent is about a century, and only a bounded slice is rendered.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/timeline-infinite-smoke.mjs
 */
import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_URL = process.env.API_URL || "http://localhost:8000";
// The old cap ended the canvas at today + 99 days.
const OLD_WALL_DAYS = 99;
const MIN_EXTENT_DAYS = 36000; // roughly a century
const MAX_RENDERED_COLUMNS = 300;

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
    /* fall through */
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
}

function daysFromToday(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${iso}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

const isoOf = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

async function readCanvas(page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    if (!body) return null;
    const header = document.querySelector("[data-day-header]");
    return {
      scrollLeft: Math.round(body.scrollLeft),
      clientWidth: body.clientWidth,
      scrollWidth: body.scrollWidth,
      columns: document.querySelectorAll("[data-day-column]").length,
      dayWidth: header ? header.getBoundingClientRect().width : 0,
      range: body.getAttribute("data-timeline-range") || "",
    };
  });
}

/**
 * Day offset from today at the left edge of the viewport. The strip maps
 * scrollLeft directly to a global day index, so the offset is simply that index
 * minus today's index.
 */
function viewportStartDay(canvas, todayIndex) {
  const dayWidth = canvas.dayWidth || 1;
  return Math.floor(canvas.scrollLeft / dayWidth) - todayIndex;
}

function rangeCovers(canvas, offset) {
  const [start, end] = canvas.range.split(":").map(daysFromToday);
  return offset >= start && offset <= end;
}

async function scrollToDay(page, index, dayWidth) {
  await page.evaluate(
    ([idx, w]) => {
      const body = document.querySelector("[data-timeline-body]");
      body.scrollLeft = idx * w;
    },
    [index, dayWidth]
  );
  // A few frames for the scroll handler and the slice rebuild to settle.
  await page.waitForTimeout(350);
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

async function main() {
  const executablePath = resolveExecutable();
  const browser = await chromium.launch({ executablePath: executablePath || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Sign up. The register form only protects itself from a native GET submit
  // once hydrated, so retry with a fresh address if that races.
  const password = "timeline-smoke-1";
  const runId = Date.now();
  let email = "";
  let registered = false;
  for (let attempt = 0; attempt < 3 && !registered; attempt++) {
    email = `tl-smoke-${runId}-${attempt}@test.local`;
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.getByPlaceholder("Your name (optional)").fill("Timeline Smoke");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("At least 8 characters").fill(password);
    await page.getByRole("button", { name: "Create Account" }).click();
    registered = await page
      .waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
  }
  assert(registered, "could not register a smoke account");
  await page.waitForSelector("[data-timeline-body]");
  assert(await dismissTour(page), "the first-run tour could not be dismissed");

  // Seed a realistic spread of far-future tasks.
  const cookies = await page.context().cookies(API_URL);
  const csrf = decodeURIComponent(cookies.find((c) => c.name === "csrf_token")?.value || "");
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const today = new Date();
  const lines = [];
  for (let i = 0; i <= 500; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    lines.push(`${i},,,,future ${i},,,"${isoOf(d)}","${isoOf(d)}"`);
  }
  // A year-long task, to guard the regression where long bars vanished once the
  // rendered slice scrolled past their start date.
  const longStart = new Date(today);
  longStart.setDate(longStart.getDate() - 30);
  const longEnd = new Date(today);
  longEnd.setDate(longEnd.getDate() + 330);
  lines.push(`long,,,,Long span,,,"${isoOf(longStart)}","${isoOf(longEnd)}"`);
  const csv =
    "TaskID,ParentID,Folder Name,List Name,Title,Tags,Is Check list,Start Date,Due Date\n" +
    lines.join("\n");
  const importRes = await fetch(`${API_URL}/api/imports/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=KILO",
      "X-CSRF-Token": csrf,
      Cookie: cookieStr,
    },
    body: `--KILO\r\nContent-Disposition: form-data; name="format"\r\n\r\nticktick\r\n--KILO\r\nContent-Disposition: form-data; name="file"; filename="t.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--KILO--\r\n`,
  });
  assert(importRes.ok, `task import failed with HTTP ${importRes.status}`);

  await page.reload();
  await page.waitForSelector("[data-timeline-body]");
  await page.waitForTimeout(2500);
  assert(await dismissTour(page), "the first-run tour reappeared after reload");

  const initial = await readCanvas(page);
  assert(initial, "timeline body not rendered");
  const dayWidth = initial.dayWidth;
  assert(dayWidth > 0, "could not measure the day width");

  // The viewport opens with today's column at the left edge minus 10 days, so
  // the global index of today is derivable from the scroll position.
  const todayIndex = Math.round(initial.scrollLeft / dayWidth) + 10;
  console.log(
    `initial: columns=${initial.columns} range=${initial.range} scrollLeft=${initial.scrollLeft} dayWidth=${dayWidth} todayIndex=${todayIndex}`
  );

  // 1. Opening view: covers today and reaches past the old wall.
  const initialStart = daysFromToday(initial.range.split(":")[0]);
  const initialEnd = daysFromToday(initial.range.split(":")[1]);
  assert(initialStart <= 0, `opening slice must include today (starts ${initialStart})`);
  assert(
    initialEnd > OLD_WALL_DAYS,
    `opening slice still ends at the old today+${OLD_WALL_DAYS} wall (ends +${initialEnd})`
  );
  assert(initial.columns > 100, `opening slice too small: ${initial.columns} columns`);

  // 2. The strip itself is about a century wide, so no reachable end exists.
  const extentDays = Math.round(initial.scrollWidth / dayWidth);
  console.log(`strip extent: ${extentDays} days`);
  assert(
    extentDays >= MIN_EXTENT_DAYS,
    `scrollable strip is only ${extentDays} days wide, expected >= ${MIN_EXTENT_DAYS}`
  );

  // 3. Walk forward across decades. Every step must land on the requested date
  //    (never backwards) and must render day columns there.
  const targets = [1500, 6000, 16000, 28000];
  let previousViewport = viewportStartDay(initial, todayIndex);
  for (const offset of targets) {
    await scrollToDay(page, todayIndex + offset, dayWidth);
    const canvas = await readCanvas(page);
    const viewport = viewportStartDay(canvas, todayIndex);
    console.log(
      `  +${offset}d -> viewport day ${viewport.toFixed(1)} columns=${canvas.columns} range=${canvas.range}`
    );
    assert(
      Math.abs(viewport - offset) <= 3,
      `scrolled to +${offset}d but the viewport shows day ${viewport.toFixed(1)}`
    );
    assert(
      viewport > previousViewport,
      `scrolling forward moved the viewport backwards (${previousViewport.toFixed(1)} -> ${viewport.toFixed(1)})`
    );
    assert(rangeCovers(canvas, offset), `rendered slice does not cover +${offset}d (${canvas.range})`);
    assert(canvas.columns > 100, `no day columns rendered at +${offset}d`);
    previousViewport = viewport;
  }

  // 3b. A long-running bar must stay on screen while the slice moves through its
  //     middle, and drop off once the viewport is well past its end. Measured by
  //     the bar's own rect crossing the viewport, since a long bar's label sits
  //     at its left end and can be scrolled off while the bar itself is visible.
  const longBarState = () =>
    page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll("[data-task-bar]")).filter((el) =>
        (el.textContent || "").includes("Long span")
      );
      const body = document.querySelector("[data-timeline-body]");
      if (!body) return { attached: false, intersects: false };
      const view = body.getBoundingClientRect();
      return {
        attached: bars.length > 0,
        intersects: bars.some((el) => {
          const r = el.getBoundingClientRect();
          return r.right > view.left + 1 && r.left < view.right - 1;
        }),
      };
    });
  for (const [offset, expected, label] of [
    [0, true, "at its start"],
    [120, true, "120 days in"],
    [300, true, "300 days in"],
    [800, false, "well past its end"],
  ]) {
    await scrollToDay(page, todayIndex + offset, dayWidth);
    await page.waitForTimeout(200);
    const state = await longBarState();
    console.log(`  long span ${label} (+${offset}d): attached=${state.attached} onScreen=${state.intersects}`);
    assert(
      state.intersects === expected,
      `year-long task should be ${expected ? "on screen" : "off screen"} ${label} (attached=${state.attached}, onScreen=${state.intersects})`
    );
  }

  // 4. Far future and far past must both be reachable in the same strip.
  await scrollToDay(page, todayIndex - 2000, dayWidth);
  const past = await readCanvas(page);
  const pastViewport = viewportStartDay(past, todayIndex);
  console.log(`  -2000d -> viewport day ${pastViewport.toFixed(1)} range=${past.range}`);
  assert(
    Math.abs(pastViewport + 2000) <= 3,
    `scrolled to -2000d but the viewport shows day ${pastViewport.toFixed(1)}`
  );
  assert(rangeCovers(past, -2000), `rendered slice does not cover -2000d (${past.range})`);

  // 5. Period controls: today parks at the opening offset, arrows page one screen.
  await page.getByRole("button", { name: "Go to today" }).click();
  await page.waitForTimeout(450);
  const afterToday = await readCanvas(page);
  const todayViewport = viewportStartDay(afterToday, todayIndex);
  assert(
    Math.abs(todayViewport + 10) <= 2,
    `"Go to today" should leave 10 days of history, got ${todayViewport.toFixed(1)}`
  );
  const todayColumn = await page.locator('[data-day-column][data-is-today="true"]').count();
  assert(todayColumn > 0, "today's column is not rendered after Go to today");

  const nextBtn = page.getByRole("button", { name: "Next period" });
  await nextBtn.click();
  await page.waitForTimeout(250);
  await nextBtn.click();
  await page.waitForTimeout(450);
  const afterNext = await readCanvas(page);
  const nextViewport = viewportStartDay(afterNext, todayIndex);
  console.log(`period next: viewport day ${todayViewport.toFixed(1)} -> ${nextViewport.toFixed(1)}`);
  assert(
    nextViewport > todayViewport + 5,
    `"Next period" should page the viewport forward (${todayViewport.toFixed(1)} -> ${nextViewport.toFixed(1)})`
  );
  await page.getByRole("button", { name: "Previous period" }).click();
  await page.waitForTimeout(450);
  const afterPrev = await readCanvas(page);
  const prevViewport = viewportStartDay(afterPrev, todayIndex);
  console.log(`period previous: viewport day ${nextViewport.toFixed(1)} -> ${prevViewport.toFixed(1)}`);
  assert(
    prevViewport < nextViewport && prevViewport > todayViewport - 5,
    `"Previous period" should page back without overshooting (${prevViewport.toFixed(1)})`
  );

  // 6. A plain vertical wheel must move the timeline when the canvas has no
  //    vertical overflow of its own (it used to do nothing at all).
  const wheelMoved = await page.evaluate(() => {
    const body = document.querySelector("[data-timeline-body]");
    if (body.scrollHeight > body.clientHeight + 1) return { skipped: true, before: 0, after: 0 };
    body.scrollLeft = 4000;
    const before = body.scrollLeft;
    body.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 0, deltaY: 300, bubbles: true, cancelable: true })
    );
    return { skipped: false, before, after: body.scrollLeft };
  });
  if (!wheelMoved.skipped) {
    assert(
      wheelMoved.after > wheelMoved.before,
      `vertical wheel did not scroll the timeline (${wheelMoved.before} -> ${wheelMoved.after})`
    );
  }

  // 7. The rendered DOM must stay bounded no matter how far the user travels.
  await scrollToDay(page, todayIndex + 28000, dayWidth);
  const bounded = await readCanvas(page);
  assert(
    bounded.columns <= MAX_RENDERED_COLUMNS,
    `day columns grew unbounded (${bounded.columns}); the slice is not being limited`
  );

  assert(pageErrors.length === 0, `unexpected page errors:\n${pageErrors.join("\n")}`);
  const suspect = consoleErrors.filter((e) =>
    /maximum update depth|too many re-renders|cannot read prop|is not a function|hydration failed/i.test(
      e
    )
  );
  assert(suspect.length === 0, `timeline render errors:\n${suspect.join("\n")}`);

  console.log(
    `PASS: fixed ${extentDays}-day strip, dates advance monotonically, DOM bounded at ${bounded.columns} columns`
  );
  await browser.close();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
