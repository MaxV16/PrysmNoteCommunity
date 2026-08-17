#!/usr/bin/env node
/**
 * Direct-API smoke test for Prysm Note.
 *
 * Primary deterministic truth for "does task creation work and land on the
 * user's date". No external dependencies — pure Node `fetch`.
 *
 * Flow:
 *   1. Register a throwaway user (random email).
 *   2. Login and capture the access token.
 *   3. Prime the csrf_token cookie via a safe GET, then create a task with
 *      start_date = today (local) sending X-CSRF-Token.
 *   4. GET the task back and assert the returned fields (title, start_date).
 *   5. Delete the task (with the CSRF header).
 *
 * Usage:
 *   BASE_URL=http://localhost:8000/api node scripts/smoke/api-smoke.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8000/api";

function localDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(`SMOKE FAIL: ${message}`);
  }
}

function parseSetCookies(setCookieHeaders) {
  const out = {};
  for (const header of setCookieHeaders || []) {
    const m = header.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function request(path, options = {}, cookie = "", csrfToken = "") {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (cookie) headers["Cookie"] = cookie;
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${JSON.stringify(body)}`);
  }
  return { body, cookies: parseSetCookies(res.headers.getSetCookie?.() ?? []) };
}

function mergeCookies(a, b) {
  return { ...a, ...b };
}

async function main() {
  const email = `smoke-${Date.now()}@test.local`;
  const password = "smoke-test-password-1";
  let cookies = {};

  console.log(`[1/5] register ${email}`);
  const reg = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: "Smoke Tester" }),
  });
  cookies = mergeCookies(cookies, reg.cookies);
  assert(cookies.access_token, "register set an access_token cookie");

  console.log("[2/5] login");
  const login = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  cookies = mergeCookies(cookies, login.cookies);
  assert(cookies.access_token, "login set an access_token cookie");

  console.log("[2.5/5] prime CSRF cookie via a safe GET");
  // /auth/me is not CSRF-exempt, so the middleware sets csrf_token on the
  // response even though a logged-in user gets 200 (and a logged-out one 401).
  const me = await request("/auth/me", {}, cookieString(cookies));
  cookies = mergeCookies(cookies, me.cookies);
  const csrfToken = cookies.csrf_token;
  assert(csrfToken, "a csrf_token cookie is set after a safe GET");
  console.log("      csrf cookie primed");

  console.log("[3/5] create task on today's date");
  const today = localDateString();
  const created = await request(
    "/tasks/",
    { method: "POST", body: JSON.stringify({ title: `smoke task ${Date.now()}`, start_date: today, status: "todo" }) },
    cookieString(cookies),
    csrfToken
  );
  const createdBody = created.body;
  assert(createdBody && createdBody.id, "create returned a task id");
  assert(createdBody.title, "create returned a title");
  assert(createdBody.start_date === today, `start_date should be today (${today}), got ${createdBody.start_date}`);
  console.log(`      created id=${createdBody.id} start_date=${createdBody.start_date}`);

  console.log("[4/5] read the task back");
  const fetched = await request(`/tasks/${createdBody.id}`, {}, cookieString(cookies));
  assert(fetched.body && fetched.body.id === createdBody.id, "read back the same task");
  assert(fetched.body.title === createdBody.title, "title round-trips");
  assert(fetched.body.start_date === today, "start_date round-trips as today");

  console.log("[5/5] delete the task (cleanup)");
  await request(`/tasks/${createdBody.id}`, { method: "DELETE" }, cookieString(cookies), csrfToken);

  console.log("\nSMOKE API PASS: register → login → create(today) → read → delete");
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
