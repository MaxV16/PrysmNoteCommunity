#!/usr/bin/env node
/**
 * Recurring-task smoke test for Prysm Note.
 *
 * Regression guard for the reported bug: a recurring task must expand into
 * individual, top-level tasks (never subtasks) that show up on the timeline /
 * calendar / list feeds, must copy the task's list (and time), and must be
 * stoppable.
 *
 * Flow:
 *   1. Register a throwaway user, log in, prime the CSRF cookie.
 *   2. The default "My Tasks" list is created lazily; read its id from /lists.
 *   3. Create a weekly recurring task with NO list -> it must land in the
 *      default list.
 *   4. Fetch the date range and assert the occurrences are separate tasks with
 *      parent_task_id = null, recurrence_parent_id = the template, the copied
 *      list id and start time.
 *   5. The default (unfiltered) feed must include the occurrences too.
 *   6. A recurring task that names a list copies that list onto its
 *      occurrences.
 *   7. Stop repeating -> future occurrences are cleared, the template stays.
 *
 * Usage:
 *   BASE_URL=http://localhost:8000/api node scripts/smoke/recurring-smoke.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8000/api";

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
}

function parseSetCookies(headers) {
  const out = {};
  for (const header of headers || []) {
    const m = header.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
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
  const email = `recurring-smoke-${Date.now()}@test.local`;
  const password = "smoke-test-password-1";
  let cookies = {};

  console.log(`[1/7] register ${email}`);
  const reg = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: "Recurring Smoke" }),
  });
  cookies = mergeCookies(cookies, reg.cookies);

  const login = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  cookies = mergeCookies(cookies, login.cookies);

  const me = await request("/auth/me", {}, cookieString(cookies));
  cookies = mergeCookies(cookies, me.cookies);
  const csrfToken = cookies.csrf_token;
  assert(csrfToken, "a csrf_token cookie is set after a safe GET");

  const auth = () => cookieString(cookies);

  console.log("[2/7] read the default list");
  const lists = await request("/lists", {}, auth());
  const defaultList = (lists.body || []).find((l) => l.is_default) || (lists.body || [])[0];
  assert(defaultList && defaultList.id, "a default list exists");
  console.log(`      default list = ${defaultList.name} (${defaultList.id})`);

  const today = localDateString();
  const far = plusDays(120);

  console.log("[3/7] create a weekly recur (no list) -> default list");
  const t1 = await request(
    "/tasks/",
    {
      method: "POST",
      body: JSON.stringify({
        title: `recurring smoke weekly ${Date.now()}`,
        start_date: today,
        start_time: "11:00",
        status: "todo",
        recurrence_rule: "FREQ=WEEKLY;BYDAY=WE",
      }),
    },
    auth(),
    csrfToken
  );
  const template1 = t1.body;
  assert(template1 && template1.id, "recurring template created");
  assert(template1.recurrence_rule, "template keeps its recurrence_rule");
  assert(
    template1.list_id === defaultList.id,
    `recurring task defaults to the main list (${defaultList.id}), got ${template1.list_id}`
  );

  console.log("[4/7] occurrences are separate top-level tasks");
  const range = await request(
    `/tasks/?date_from=${today}&date_to=${far}`,
    {},
    auth()
  );
  const feed = range.body || [];
  const occ1 = feed.filter((t) => t.recurrence_parent_id === template1.id);
  assert(occ1.length >= 8, `expected several weekly occurrences, got ${occ1.length}`);
  assert(feed.some((t) => t.id === template1.id), "template itself is in the feed");
  for (const o of occ1) {
    assert(o.parent_task_id == null, `occurrence ${o.id} must NOT be a subtask`);
    assert(o.list_id === defaultList.id, `occurrence ${o.id} copies the main list`);
    assert(o.start_time === "11:00", `occurrence ${o.id} copies the time, got ${o.start_time}`);
    assert(weekdayOf(o.start_date) === 3, `occurrence ${o.id} lands on Wednesday, got ${o.start_date}`);
  }
  console.log(`      ${occ1.length} occurrences, all top-level and in the main list`);

  console.log("[5/7] occurrences appear in the default feed too");
  const snapshot = await request("/tasks/?limit=200", {}, auth());
  const snapOcc = (snapshot.body || []).filter((t) => t.recurrence_parent_id === template1.id);
  assert(snapOcc.length >= 1, "occurrences show in the unfiltered feed without scrolling");

  console.log("[6/7] a named list is copied onto occurrences");
  const mk = await request(
    "/lists",
    { method: "POST", body: JSON.stringify({ name: "mobile app list" }) },
    auth(),
    csrfToken
  );
  const mobileList = mk.body;
  assert(mobileList && mobileList.id, "named list created");
  const t2 = await request(
    "/tasks/",
    {
      method: "POST",
      body: JSON.stringify({
        title: `recurring smoke daily ${Date.now()}`,
        start_date: today,
        status: "todo",
        list_id: mobileList.id,
        recurrence_rule: "FREQ=DAILY",
      }),
    },
    auth(),
    csrfToken
  );
  const template2 = t2.body;
  assert(template2 && template2.id, "third recurring template created");
  const range2 = await request(`/tasks/?date_from=${today}&date_to=${plusDays(30)}`, {}, auth());
  const occ2 = (range2.body || []).filter((t) => t.recurrence_parent_id === template2.id);
  assert(occ2.length >= 5, `expected daily occurrences, got ${occ2.length}`);
  for (const o of occ2) {
    assert(o.list_id === mobileList.id, `occurrence ${o.id} copies the named list`);
    assert(o.parent_task_id == null, `occurrence ${o.id} must NOT be a subtask`);
  }

  console.log("[7/7] stopping the repeat clears future occurrences");
  const stopped = await request(
    `/tasks/${template1.id}/recurrence`,
    { method: "DELETE" },
    auth(),
    csrfToken
  );
  assert(stopped.body && stopped.body.status === "stopped", "stop returns status=stopped");
  const after = await request(`/tasks/?date_from=${today}&date_to=${far}`, {}, auth());
  const future = (after.body || []).filter(
    (t) => t.recurrence_parent_id === template1.id && t.start_date > today
  );
  assert(future.length === 0, `no future occurrences remain, got ${future.length}`);

  console.log(
    "\nSMOKE RECURRING PASS: recurring tasks expand into visible top-level occurrences with list + time, and stop clears future repeats"
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
