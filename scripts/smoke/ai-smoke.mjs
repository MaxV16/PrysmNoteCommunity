#!/usr/bin/env node
/**
 * Live AI smoke test for Prysm Note.
 *
 * Registers a throwaway account, grants the hosted trial (needed for the
 * server-side `prysmai` provider), then exercises real model turns through
 * `POST /api/ai/chat`. Assertions are checked against REST side effects, not
 * the model's prose or the final-round `tool_calls` field (which is null after
 * the streaming answer even when tools ran in an earlier round).
 *
 * Usage:
 *   BASE_URL=https://prysmnote.com/api node scripts/smoke/ai-smoke.mjs
 *   BASE_URL=http://localhost:8000/api AI_PROVIDER=openrouter BYOK_KEY=... node scripts/smoke/ai-smoke.mjs
 *
 * The default provider is `prysmai`, which uses the server key and therefore
 * needs an active plan or trial. Do not run this against production in a loop;
 * each case is one paid model round.
 */

const BASE_URL = (process.env.BASE_URL || "http://localhost:8000/api").replace(/\/$/, "");
const PROVIDER = process.env.AI_PROVIDER || "prysmai";
const BYOK_KEY = process.env.BYOK_KEY || "";
const STAMP = `${Date.now()}`;
const TITLE = `AI smoke ${STAMP}`;
const TRIAL_PATH = ["", "ee", "billing", "trial", "start"].join("/");
const RECUR_TITLE = `AI weekly ${STAMP}`;

function assert(cond, message) {
  if (!cond) throw new Error(`AI SMOKE FAIL: ${message}`);
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function parseSetCookies(headers) {
  const out = {};
  for (const header of headers || []) {
    const m = header.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function request(path, options = {}, cookies = {}, csrf = "") {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const jar = cookieString(cookies);
  if (jar) headers.Cookie = jar;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, ok: res.ok, body, cookies: parseSetCookies(res.headers.getSetCookie?.() ?? []) };
}

function merged(a, b) {
  return { ...a, ...b };
}

function toolNames(response) {
  const calls = response?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((c) => c?.function?.name).filter(Boolean);
}

async function searchTasks(cookies, query) {
  const res = await request(`/tasks/?query=${encodeURIComponent(query)}`, {}, cookies);
  assert(res.ok, `task search for "${query}" returned HTTP ${res.status}`);
  const list = Array.isArray(res.body) ? res.body : res.body?.tasks || res.body?.items || [];
  return list;
}

async function chat(cookies, csrf, message) {
  const res = await request(
    "/ai/chat",
    { method: "POST", body: JSON.stringify({ message, provider: PROVIDER, chat_history: [] }) },
    cookies,
    csrf
  );
  assert(res.ok, `chat "${message}" returned HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  assert(res.body && typeof res.body.content === "string", "chat returned a content string");
  console.log(`      tools=${JSON.stringify(toolNames(res.body))} reply="${res.body.content.slice(0, 120)}"`);
  return res.body;
}

async function main() {
  const email = `ai-smoke-${STAMP}@test.local`;
  const password = "ai-smoke-password-1";
  let cookies = {};

  console.log(`[1] register ${email} against ${BASE_URL}`);
  const reg = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: "AI Smoke" }),
  });
  assert(reg.ok, `register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  cookies = merged(cookies, reg.cookies);

  if (!cookies.access_token) {
    console.log("      register did not return a session; signing in");
    const login = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    assert(login.ok, `login failed: ${login.status} ${JSON.stringify(login.body)}`);
    cookies = merged(cookies, login.cookies);
  }
  assert(cookies.access_token, "login set an access_token cookie");

  const me = await request("/auth/me", {}, cookies);
  cookies = merged(cookies, me.cookies);
  const csrf = cookies.csrf_token;
  assert(csrf, "csrf_token cookie primed");

  if (BYOK_KEY) {
    console.log(`[2] store a BYOK key for ${PROVIDER}`);
    const saved = await request(
      "/keys",
      { method: "POST", body: JSON.stringify({ provider: PROVIDER, api_key: BYOK_KEY }) },
      cookies,
      csrf
    );
    assert(saved.ok, `saving the BYOK key failed: ${saved.status} ${JSON.stringify(saved.body)}`);
  } else if (PROVIDER === "prysmai") {
    console.log("[2] grant the hosted trial");
    const trial = await request(TRIAL_PATH, { method: "POST" }, cookies, csrf);
    assert(trial.ok, `trial start failed: ${trial.status} ${JSON.stringify(trial.body)}`);
  }

  const failures = [];
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.log(`FAIL  ${name}: ${err.message}`);
    }
  };

  console.log("[3] live model cases");

  await check("typo create creates the task", async () => {
    await chat(cookies, csrf, `add taks called ${TITLE} tomorow at 9am`);
    const found = await searchTasks(cookies, TITLE);
    const task = found.find((t) => (t.title || "").includes(TITLE));
    assert(task, "created task is searchable");
    assert(task.start_date || task.due_date, "created task has a date");
  });

  await check("done marks done instead of deleting", async () => {
    await chat(cookies, csrf, `marks the ${TITLE} task as done`);
    const found = await searchTasks(cookies, TITLE);
    const task = found.find((t) => (t.title || "").includes(TITLE));
    assert(task, "task still exists after completion");
    assert(task.status === "done", `task status should be done, got ${task.status}`);
    assert(!task.deleted_at, "task was not deleted");
  });

  await check("first delete request asks and does not delete", async () => {
    await chat(cookies, csrf, `delete the ${TITLE} task`);
    const found = await searchTasks(cookies, TITLE);
    assert(found.some((t) => (t.title || "").includes(TITLE)), "task survives the unconfirmed delete request");
  });

  await check("search answers from real rows", async () => {
    const reply = await chat(cookies, csrf, `what do i have about ${TITLE}?`);
    assert(
      reply.content.toLowerCase().includes("ai smoke") || reply.content.includes(STAMP),
      `search turn should mention the seeded row, got: ${reply.content.slice(0, 200)}`
    );
  });

  await check("ambiguous date query is handled", async () => {
    const reply = await chat(cookies, csrf, "wat do i hav tomorow");
    assert(reply.content.trim().length > 0, "ambiguous query should still produce a grounded answer");
    assert(
      !reply.content.toLowerCase().includes("could not make that change"),
      "ambiguous read-only query must not be replaced by the mutation-failure fallback"
    );
  });

  await check("recurring create stores a recurrence", async () => {
    await chat(cookies, csrf, `create a task called ${RECUR_TITLE} every monday at 10am`);
    const found = await searchTasks(cookies, RECUR_TITLE);
    const task = found.find((t) => (t.title || "").includes(RECUR_TITLE));
    assert(task, "recurring task is searchable");
    assert(task.recurrence_rule, "task carries a recurrence_rule");
  });

  console.log("[4] cleanup");
  for (const query of [TITLE, RECUR_TITLE]) {
    for (const task of await searchTasks(cookies, query)) {
      if ((task.title || "").includes(query)) {
        await request(`/tasks/${task.id}`, { method: "DELETE" }, cookies, csrf);
      }
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} live AI case(s) failed:\n- ${failures.join("\n- ")}`);
  }
  console.log("\nAI SMOKE PASS: create, complete, delete-confirmation, search, ambiguous date, recurrence");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
