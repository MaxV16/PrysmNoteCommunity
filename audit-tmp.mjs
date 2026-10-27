import { chromium } from "playwright";
const EXE = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1244/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = process.env.BASE || "https://prysmnote.com";
const paths = (process.env.PATHS || "").split(",").filter(Boolean);
const width = Number(process.env.W || 412);
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width, height: 900 } });
for (const p of paths) {
  const page = await ctx.newPage();
  const errs = [];
  const bad = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 90)}`); });
  page.on("pageerror", (e) => errs.push("PAGEERROR " + String(e).slice(0, 100)));
  let settled = "timeout";
  const t0 = Date.now();
  await page.goto(BASE + p, { waitUntil: "load", timeout: 45000 });
  try { await page.waitForLoadState("networkidle", { timeout: 12000 }); settled = (Date.now() - t0) + "ms"; } catch {}
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const burger = await page.locator('[aria-label="Toggle navigation"]').count();
  const title = await page.title();
  console.log(JSON.stringify({ path: p, settled, errs: errs.length, bad: bad.slice(0, 4), overflow, burger, title: title.slice(0, 60) }));
  await page.close();
}
await browser.close();
