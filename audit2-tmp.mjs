import { chromium } from "playwright";
const EXE = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1244/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
for (const p of ["/cookie-policy", "/privacy", "/tos", "/marketing/legal"]) {
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`  [${p}] CONSOLE: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => console.log(`  [${p}] PAGEERROR: ${String(e).slice(0, 160)}`));
  await page.goto("https://prysmnote.com" + p, { waitUntil: "load", timeout: 45000 });
  await page.waitForTimeout(2500);
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(JSON.stringify({ path: p, title: await page.title(), h1: (h1 || "").slice(0, 50) }));
  await page.close();
}
await browser.close();
