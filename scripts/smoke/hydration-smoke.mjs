#!/usr/bin/env node
/**
 * Regression check for hydration: a fresh load of the public entry pages must
 * produce zero console errors and zero uncaught page errors, the server HTML
 * must not bake in browser-only state, and the document head must not contain
 * duplicate stylesheet links.
 *
 * Two real bugs are guarded here, both of which surfaced as
 * "Minified React error #418 ... args[]=HTML" on every page load:
 *
 * 1. The offline banner rendered on the server. Node 22 has a global
 *    `navigator` without `onLine`, so the "online?" check came back undefined
 *    (falsy) in SSR and true in the browser, so the server HTML carried a
 *    banner the client dropped. Fixed in `lib/use-online-status.ts` (unknown
 *    means online); the SSR assertion below catches a regression directly.
 * 2. The IBM Plex stylesheet was a `<link rel="stylesheet">` in a hand-written
 *    `<head>` in the root layout: rendered in place on the server, hoisted by
 *    React on the client, which inserted a SECOND copy.
 *
 * Runs against a real production build (`next build` + `next start`) as well as
 * the live site. Coordinate-free: it only reads console output and the DOM.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/hydration-smoke.mjs
 *   BASE_URL=https://prysmnote.com node scripts/smoke/hydration-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// Public pages that render for a logged-out visitor: the marketing landing and
// the sign-in page. Both mount the whole provider stack from the root layout.
const PATHS = ["/", "/login"];

function resolveExecutable() {
  if (process.env.EXECUTABLE_PATH) return process.env.EXECUTABLE_PATH;
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "win32"
      ? `${process.env.LOCALAPPDATA}\\ms-playwright`
      : `${os.homedir()}/Library/Caches/ms-playwright`);
  const layouts = [
    ["chrome-win/headless_shell.exe", "chrome-win/chrome.exe"],
    ["chrome-mac/headless_shell", "chrome-mac/Chromium"],
    ["chrome-linux/headless_shell", "chrome-linux/chrome"],
  ];
  try {
    for (const dir of fs.readdirSync(cacheRoot)) {
      if (!dir.startsWith("chromium")) continue;
      for (const group of layouts) {
        for (const candidate of group) {
          const p = `${cacheRoot}/${dir}/${candidate}`;
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch {}
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Console lines that are never a hydration problem (network noise). */
const IGNORED = [
  /Failed to load resource/i,
  /net::ERR_/i,
  // A local build bakes NEXT_PUBLIC_API_URL=http://localhost:8000, which the
  // production CSP blocks. That is environment noise, not hydration.
  /violates the following Content Security Policy directive/i,
  /Fetch API cannot load/i,
];

async function main() {
  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const failures = [];

  for (const path of PATHS) {
    console.log(`\n[${path}] fresh load of ${BASE_URL}${path}`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (IGNORED.some((re) => re.test(text))) return;
      errors.push(`console: ${text}`);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${String(err).split("\n")[0]}`));

    const response = await page.goto(`${BASE_URL}${path}`, {
      waitUntil: "load",
      timeout: 60000,
    });
    assert(response, `expected an HTTP response for ${path}`);
    assert(
      response.status() === 200,
      `expected HTTP 200 for ${path} (got ${response.status()})`
    );

    // Give hydration and the post-mount effects time to run before reading.
    await page.waitForTimeout(3000);

    // Server HTML must not contain browser-only "we are offline" state: the
    // browser hydration would immediately disagree with it.
    const ssrResponse = await context.request.get(`${BASE_URL}${path}`, {
      headers: { accept: "text/html" },
    });
    const ssrHtml = await ssrResponse.text();
    const offlineBannerInSsr = ssrHtml.includes(
      "You are offline. Some features may be unavailable."
    );

    const duplicateStylesheets = await page.evaluate(() => {
      const seen = new Map();
      const dups = [];
      for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
        const href = link.getAttribute("href");
        if (!href) continue;
        if (seen.has(href)) dups.push(href);
        else seen.set(href, true);
      }
      return dups;
    });

    if (errors.length) failures.push(`${path}: ${errors.join(" | ")}`);
    if (offlineBannerInSsr) {
      failures.push(`${path}: server HTML contains the offline banner (SSR/client mismatch)`);
    }
    if (duplicateStylesheets.length) {
      failures.push(`${path}: duplicate stylesheet link(s): ${duplicateStylesheets.join(", ")}`);
    }

    console.log(`  console errors: ${errors.length}`);
    console.log(`  offline banner in server HTML: ${offlineBannerInSsr ? "YES" : "no"}`);
    console.log(`  duplicate stylesheet links: ${duplicateStylesheets.length}`);
    if (errors.length) errors.forEach((e) => console.log(`    ${e}`));
    if (duplicateStylesheets.length) {
      duplicateStylesheets.forEach((h) => console.log(`    ${h}`));
    }

    await context.close();
  }

  await browser.close();

  assert(
    failures.length === 0,
    `hydration smoke failed:\n  ${failures.join("\n  ")}`
  );
  console.log("\nSMOKE HYDRATION PASS: no console errors and no duplicate stylesheets");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
