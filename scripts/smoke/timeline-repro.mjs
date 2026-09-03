#!/usr/bin/env node
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
  return "";
}
const EXECUTABLE_PATH = resolveExecutable();

async function main() {
  const email = `tl-${Date.now()}@test.local`;
  const password = "timeline-repro-1";
  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE_URL}/register`);
  await page.getByPlaceholder("Your name (optional)").fill("TL Repro");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("At least 8 characters").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 25000 });

// Seed a dataset mimicking a real large TickTick import: ~3000 tasks dated one per
// day across a 10-year window, so the timeline must expand and pan far into the future.
  await page.waitForSelector("[data-timeline-body]");
  const cookies = await page.context().cookies("http://localhost:8000");
  const csrfRaw = cookies.find((c) => c.name === "csrf_token")?.value || "";
  const csrf = decodeURIComponent(csrfRaw);
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const today = new Date();
  const iso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    const d = new Date(today.getFullYear() - 5, 0, 1);
    d.setDate(d.getDate() + i);
    const s = iso(d);
    lines.push(`${i},,,,seeded ${i},,,"${s}","${s}"`);
  }
  const csv = "TaskID,ParentID,Folder Name,List Name,Title,Tags,Is Check list,Start Date,Due Date\n" + lines.join("\n");;
  let importRes = null;
  try {
    importRes = await fetch("http://localhost:8000/api/imports/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=KILO",
        "X-CSRF-Token": csrf,
        Cookie: cookieStr,
      },
      body: `--KILO\r\nContent-Disposition: form-data; name="format"\r\n\r\nticktick\r\n--KILO\r\nContent-Disposition: form-data; name="file"; filename="t.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--KILO--\r\n`,
    });
  } catch (e) {
    importRes = { status: "exception", ok: false, txt: String(e) };
  }
  const importBody = importRes.ok ? await importRes.text() : "";
  console.log("import:", importRes.status, importBody.slice(0, 200));
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForTimeout(2500);

  const info = async (label) => {
    const data = await page.evaluate(() => {
      const body = document.querySelector("[data-timeline-body]");
      const headers = Array.from(document.querySelectorAll("[data-day-header]"));
      const nums = headers.map((h) => h.textContent.trim());
      const lane = document.querySelector("[data-timeline-body] .relative");
      return {
        scrollLeft: body ? Math.round(body.scrollLeft) : null,
        clientWidth: body ? body.clientWidth : null,
        canvasWidth: lane ? lane.getBoundingClientRect().width : null,
        bodyScrollWidth: body ? body.scrollWidth : null,
        callScrollWidth: body ? body.scrollWidth : null,
        headerCount: nums.length,
        first: nums.slice(0, 3),
        last: nums.slice(-5),
        headerBox: headers.length
          ? { w: headers[0].getBoundingClientRect().width, h: headers[0].getBoundingClientRect().height }
          : null,
      };
    });
    console.log(label, JSON.stringify(data));
  };

  await info("initial:");

  // Set a realistic laptop viewport, then open the AI panel the way a real user
  // would - both shrink the timeline body so mount-time auto-expansion is less
  // likely to pre-empt the visible window.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator('button[title="AI"]').waitFor({ state: "visible" });
  await page.locator('button[title="AI"]').click();
  await page.waitForTimeout(800);
  await info("after AI panel open (narrow):");
  const before = await page.evaluate(() => document.querySelectorAll("[data-day-header]").length);

  // Simulate a real user with a trackpad: horizontal wheel deltaX events aimed
  // at the timeline body's own center (not the AI panel).
  const bodyBox = await page.locator("[data-timeline-body]").boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(800);
  await info("after wheel scroll to right:");

  const after = await page.evaluate(() => document.querySelectorAll("[data-day-header]").length);
  console.log("header count", before, "->", after, after > before ? "(grew)" : "(DID NOT GROW)");

  await browser.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});