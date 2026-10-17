#!/usr/bin/env node
/**
 * Content smoke: settings copy, theme/chrome contrast, and image/link input in
 * task descriptions and subtasks.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/smoke/content-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const APP_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_URL = process.env.API_URL || `${APP_URL.replace(":3000", ":8000")}/api`;
const STAMP = `${Date.now()}`;
const TITLE = `Content smoke ${STAMP}`;
const EMAIL = `content-smoke-${STAMP}@test.local`;
const PASSWORD = "content-smoke-password-1";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3ZkAAAAASUVORK5CYII=";

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
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function assert(cond, message) {
  if (!cond) throw new Error(`CONTENT SMOKE FAIL: ${message}`);
}

async function api(request, path, options = {}) {
  const res = await request.fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status(), ok: res.ok(), body, res };
}

async function contrastRatio(page, selector) {
  return page.evaluate((sel) => {
    const parse = (value) => {
      const nums = value.match(/[\d.]+/g);
      if (!nums) return null;
      const rgb = nums.slice(0, 3).map(Number);
      // Chrome serializes color-mix() results as color(srgb r g b) with 0..1
      // channels, while plain colors come back as rgb() with 0..255 channels.
      return value.startsWith("color(") ? rgb.map((v) => v * 255) : rgb;
    };
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const el = document.querySelector(sel);
    if (!el) return null;
    const color = parse(getComputedStyle(el).color);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const raw = getComputedStyle(node).backgroundColor;
      if (raw && raw !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(raw)) bg = parse(raw);
      node = node.parentElement;
    }
    if (!color || !bg) return null;
    const l1 = luminance(color);
    const l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, selector);
}

async function chromeValues(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const chrome = document.querySelector(".app-chrome");
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--bg-surface)";
    document.body.appendChild(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      chromeBg: chrome ? getComputedStyle(chrome).backgroundColor : null,
      surface,
      muted: root.getPropertyValue("--text-muted").trim(),
    };
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  console.log(`[1/7] session + task against ${API_URL}`);
  const reg = await api(context.request, "/auth/register", {
    method: "POST",
    data: JSON.stringify({ email: EMAIL, password: PASSWORD, display_name: "Content Smoke" }),
  });
  assert(reg.ok, `register failed: ${reg.status}`);
  if (!(await context.cookies()).some((c) => c.name === "access_token")) {
    const login = await api(context.request, "/auth/login", {
      method: "POST",
      data: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert(login.ok, `login failed: ${login.status}`);
  }
  await api(context.request, "/auth/me");
  const csrf = (await context.cookies()).find((c) => c.name === "csrf_token")?.value || "";
  assert(csrf, "csrf token primed");

  const today = new Date();
  const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const created = await api(context.request, "/tasks/", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
    data: JSON.stringify({ title: TITLE, start_date: startDate, status: "todo" }),
  });
  assert(created.ok, `task create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const taskId = created.body.id;

  console.log("[2/7] open the task and add a description link + image");
  await page.goto(`${APP_URL}/`);
  await page.getByTestId("new-task-button").waitFor({ state: "visible", timeout: 30000 });
  try {
    await page.getByText(TITLE, { exact: true }).first().click({ timeout: 8000 });
  } catch {
    await page.reload();
    await page.getByText(TITLE, { exact: true }).first().click({ timeout: 15000 });
  }
  await page.getByText("No description - click to add one", { exact: true }).click();
  const desc = page.getByPlaceholder("Write a description (markdown supported)…");
  await desc.waitFor({ state: "visible" });
  await desc.fill("[OpenAI](https://openai.com)");
  await page.getByRole("button", { name: "Add image" }).click();
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "content-smoke.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea[placeholder="Write a description (markdown supported)…"]');
    return ta instanceof HTMLTextAreaElement && ta.value.includes("![content-smoke](");
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();

  const descriptionImg = page.locator(".markdown-body img").first();
  await descriptionImg.waitFor({ state: "visible" });
  try {
    await page.waitForFunction(
      () => {
        const img = document.querySelector(".markdown-body img");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
      },
      null,
      { timeout: 15000 }
    );
  } catch {
    const info = await descriptionImg.evaluate((img) => ({
      src: img.getAttribute("src"),
      resolved: img.currentSrc || img.src,
      outer: img.outerHTML,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    }));
    console.error("[image debug]", JSON.stringify(info));
    throw new Error(`uploaded description image did not load: ${JSON.stringify(info)}`);
  }
  assert(await descriptionImg.evaluate((img) => img.complete && img.naturalWidth > 0), "uploaded description image should load");
  const descriptionLink = page.locator('.markdown-body a[href="https://openai.com"]').first();
  assert(await descriptionLink.count(), "description markdown link should render");
  assert((await descriptionLink.getAttribute("target")) === "_blank", "description links open in a new tab");

  console.log("[3/7] add a subtask with a link description");
  await page.getByPlaceholder("Add subtask...").fill("Reference links");
  await page
    .locator('input[placeholder="Add subtask..."]')
    .locator("xpath=following-sibling::button[1]")
    .click();
  const subtaskRow = page.locator("div").filter({ hasText: /^Reference links$/ }).first();
  await page.getByLabel("Edit description for Reference links").click();
  const subDesc = page.getByPlaceholder("Add notes, links, or images...");
  await subDesc.waitFor({ state: "visible" });
  await subDesc.fill("[Docs](https://example.com)");
  await page.getByRole("button", { name: "Done", exact: true }).last().click();
  const subtaskLink = page.locator('.markdown-body a[href="https://example.com"]').first();
  await subtaskLink.waitFor({ state: "visible" });
  assert((await subtaskLink.getAttribute("target")) === "_blank", "subtask links open in a new tab");

  console.log("[4/7] Settings shows the paused Idea Engine copy");
  await page.goto(`${APP_URL}/settings`);
  await page.getByRole("button", { name: "Premium", exact: true }).click();
  await page.getByText("Idea Engine", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Work in progress", { exact: true }).waitFor({ state: "visible" });
  assert((await page.getByText("Coming soon", { exact: true }).count()) === 0, "redundant Coming soon button should be gone");
  assert(
    (await page.getByText("The Process idea action is paused while we finish this workflow.", { exact: false }).count()) > 0,
    "paused explanation should be visible"
  );

  console.log("[5/7] theme chrome separates from content surfaces");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => window.localStorage.setItem("prysm-theme", value), theme);
    await page.goto(`${APP_URL}/`);
    await page.getByTestId("new-task-button").waitFor({ state: "visible" });
    await page.locator(".app-chrome").first().waitFor({ state: "visible" });
    const values = await chromeValues(page);
    assert(values.chromeBg, `${theme}: sidebar should render`);
    assert(values.chromeBg !== values.surface, `${theme}: sidebar should not match content surfaces (${values.chromeBg} vs ${values.surface})`);
    assert(values.muted && values.muted !== "undefined", `${theme}: muted token should resolve`);
    const ratio = await contrastRatio(page, "p.text-muted, .text-muted");
    assert(ratio && ratio >= 3, `${theme}: muted helper text contrast too low (${ratio})`);
    console.log(`      ${theme}: chrome ${values.chromeBg} vs surface ${values.surface}, muted contrast ${ratio?.toFixed(2)}:1`);
  }

  console.log("[6/7] cleanup");
  await api(context.request, `/tasks/${taskId}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrf },
  });

  console.log("[7/7] done");
  await browser.close();
  console.log("\nCONTENT SMOKE PASS: description image/link, subtask link, Settings WIP copy, theme chrome contrast");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
