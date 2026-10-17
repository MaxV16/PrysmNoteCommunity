#!/usr/bin/env node
/**
 * Live AI UI smoke test (Playwright) for Prysm Note.
 *
 * Drives the real chat panel against a live model. Auth is created through the
 * API (shared browser cookies), then every model turn and side effect is
 * verified through the UI plus the REST API:
 *   1. create a task by voice-style prompt
 *   2. read-only search summary must not be replaced by a failure message
 *   3. mark the task done by TITLE (the resolver fix)
 *   4. a delete request must ask for confirmation and not delete
 *
 * Usage:
 *   BASE_URL=https://prysmnote.com node scripts/smoke/ai-ui-smoke.mjs
 *   BASE_URL=http://localhost:3000 node scripts/smoke/ai-ui-smoke.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";

const APP_URL = (process.env.BASE_URL || "https://prysmnote.com").replace(/\/$/, "");
const API_URL = `${APP_URL}/api`;
const STAMP = `${Date.now()}`;
const TITLE = `AI UI smoke ${STAMP}`;
const TRIAL_PATH = ["", "ee", "billing", "trial", "start"].join("/");

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
  if (!cond) throw new Error(`AI UI SMOKE FAIL: ${message}`);
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

async function findTask(request, query) {
  const res = await api(request, `/tasks/?query=${encodeURIComponent(query)}`);
  assert(res.ok, `task search returned HTTP ${res.status}`);
  const list = Array.isArray(res.body) ? res.body : res.body?.tasks || res.body?.items || [];
  return list.find((t) => t.title === TITLE) || null;
}

async function assistantBubbles(page) {
  return page.locator('[data-ai-dock] .rounded-bl-md');
}

async function sendAndWait(page, message, predicate, timeout = 120000) {
  const before = await assistantBubbles(page).count();
  await page.getByPlaceholder("Ask Prysm Note…").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-ai-dock] .rounded-bl-md").length > n,
    before,
    { timeout: 20000 }
  );
  const bubble = assistantBubbles(page).last();
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = (await bubble.innerText().catch(() => "")) || "";
    if (predicate(last)) return last;
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out waiting for reply. Last reply: ${last.slice(0, 400)}`);
}

async function main() {
  const email = `ai-ui-${STAMP}@test.local`;
  const password = "ai-ui-smoke-password-1";

  const browser = await chromium.launch({ executablePath: resolveExecutable() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  console.log(`[1/6] create a session against ${APP_URL}`);
  const reg = await api(context.request, "/auth/register", {
    method: "POST",
    data: JSON.stringify({ email, password, display_name: "AI UI Smoke" }),
  });
  assert(reg.ok, `register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const cookies = await context.cookies();
  if (!cookies.some((c) => c.name === "access_token")) {
    const login = await api(context.request, "/auth/login", {
      method: "POST",
      data: JSON.stringify({ email, password }),
    });
    assert(login.ok, `login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const me = await api(context.request, "/auth/me");
  assert(me.ok, `auth/me failed: ${me.status}`);
  const csrf = (await context.cookies()).find((c) => c.name === "csrf_token")?.value || "";
  assert(csrf, "csrf token primed");

  const trial = await api(context.request, TRIAL_PATH, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
    data: "{}",
  });
  assert(trial.ok, `trial start failed: ${trial.status} ${JSON.stringify(trial.body)}`);

  console.log("[2/6] open the app and the live chat panel");
  await page.goto(`${APP_URL}/`);
  await page.getByTestId("new-task-button").waitFor({ state: "visible", timeout: 30000 });
  assert((await page.getByRole("button", { name: "Process idea" }).count()) === 0, "Idea Engine entry point should be hidden");
  await page.locator('button[aria-label="AI"]').first().click();
  await page.getByPlaceholder("Ask Prysm Note…").waitFor({ state: "visible", timeout: 15000 });

  console.log("[3/6] create a task through the live model");
  const createdReply = await sendAndWait(page, `Create a task called "${TITLE}" for tomorrow at 9am.`, (t) =>
    t.toLowerCase().includes("ai ui smoke") && (t.toLowerCase().includes("created") || t.toLowerCase().includes("added"))
  );
  console.log(`      reply: ${createdReply.slice(0, 140).replace(/\n/g, " ")}`);
  let task = await findTask(context.request, TITLE);
  assert(!!task, "created task should exist through the REST API");
  const taskId = task.id;
  assert(task.start_date || task.due_date, "created task should carry a date");

  console.log("[4/6] read-only search must not be replaced by a failure message");
  const searchReply = await sendAndWait(page, "Which tasks do I have tomorrow?", (t) =>
    t.toLowerCase().includes("ai ui smoke") && t.length > 20
  );
  assert(!/could not make that change/i.test(searchReply), "a read-only search summary must not be replaced");
  console.log(`      reply: ${searchReply.slice(0, 140).replace(/\n/g, " ")}`);

  console.log("[5/6] complete the task by TITLE (no UUID in the prompt)");
  const doneReply = await sendAndWait(page, `Mark "${TITLE}" as done.`, (t) =>
    /(done|completed|marked|finished)/i.test(t) && t.length > 10
  );
  console.log(`      reply: ${doneReply.slice(0, 140).replace(/\n/g, " ")}`);
  let doneTask = null;
  const doneDeadline = Date.now() + 25000;
  while (Date.now() < doneDeadline) {
    doneTask = await findTask(context.request, TITLE);
    if (doneTask?.status === "done") break;
    await page.waitForTimeout(1000);
  }
  assert(doneTask && doneTask.status === "done", `task should be done after the title-based request (status ${doneTask?.status})`);

  console.log("[6/6] a delete request asks for confirmation and does not delete");
  const deleteReply = await sendAndWait(page, `Delete "${TITLE}".`, (t) =>
    /delete/i.test(t) && (t.includes("?") || /confirm/i.test(t))
  );
  assert(!/deleted|removed it|moved to trash/i.test(deleteReply), `delete must not execute before confirmation: ${deleteReply.slice(0, 200)}`);
  const stillThere = await findTask(context.request, TITLE);
  assert(!!stillThere, "task must still exist before the user confirms deletion");

  console.log("      cleaning up the smoke task");
  await api(context.request, `/tasks/${taskId}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrf },
  });

  await browser.close();
  console.log("\nSMOKE AI UI PASS: create -> search -> complete by title -> delete confirmation (live model)");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
