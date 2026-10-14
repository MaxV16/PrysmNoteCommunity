#!/usr/bin/env node
/**
 * Headless-DOM regression check: a recurring task must render on the timeline
 * as several individual bars (one per occurrence), not a single template bar and
 * not hidden inside the task as a subtask.
 *
 * Creates the recurring task through the API (same-origin fetch with the app's
 * CSRF cookie), then asserts the timeline DOM shows more than one bar with the
 * title - i.e. the occurrences are individually visible.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/recurring-ui-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// The dev frontend calls the backend directly (NEXT_PUBLIC_API_URL), so the
// create goes to the API origin, not through the app origin.
const API_BASE = process.env.API_BASE || "http://localhost:8000/api";

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
    // fall through
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function localDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
}

async function main() {
  const email = `recurui-${Date.now()}@test.local`;
  const password = "recur-ui-password-1";
  const title = `recur ui ${Date.now()}`;
  const todayStr = localDateString();

  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);

  console.log("[1/4] register a fresh user");
  await page.goto(`${BASE_URL}/register`);
  await page.getByPlaceholder("Your name (optional)").fill("Recur UI");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("At least 8 characters").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/register"));
  console.log("      landed on", page.url());

  console.log("[2/4] create a DAILY recurring task via the API");
  const created = await page.evaluate(
    async ({ title, todayStr, apiBase }) => {
      const csrf = document.cookie
        .split("; ")
        .find((c) => c.startsWith("csrf_token="))
        ?.split("=")[1];
      const res = await fetch(`${apiBase}/tasks/`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
        body: JSON.stringify({
          title,
          start_date: todayStr,
          start_time: "11:00",
          status: "todo",
          recurrence_rule: "FREQ=DAILY",
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { title, todayStr, apiBase: API_BASE }
  );
  assert(created.status === 200 || created.status === 201, `create failed: ${created.status}`);
  assert(created.body && created.body.id, "create returned a task id");

  console.log("[3/4] reload the timeline");
  await page.reload();
  await page.waitForTimeout(2500);

  console.log(`[4/4] assert several bars for "${title}" are rendered (template + occurrences)`);
  let bars = page.getByText(title, { exact: true });
  let count = await bars.count();
  if (count < 2) {
    // The lazy range fetch may still be settling; give it a beat and recount.
    await page.waitForTimeout(2500);
    bars = page.getByText(title, { exact: true });
    count = await bars.count();
  }
  assert(
    count >= 2,
    `expected the template plus at least one occurrence bar, saw ${count} (occurrences not rendered as individual tasks)`
  );

  const todayColumn = page.locator('[data-day-column][data-is-today="true"]');
  assert((await todayColumn.count()) >= 1, "the timeline should show a today column");

  await browser.close();
  console.log(
    `\nSMOKE RECURRING UI PASS: daily recurring task renders ${count} individual bars on the timeline`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
