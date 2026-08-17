import { chromium } from "@playwright/test";

const FRONT = process.env.FRONT_URL || "http://localhost:3000";
const API = process.env.API_URL || "http://localhost:8000/api";
const EXECUTABLE_PATH = process.env.EXECUTABLE_PATH || undefined;

function assert(cond, message) {
  if (!cond) throw new Error(`VERIFY FAIL: ${message}`);
}

// Register a fresh user via the backend and capture the HttpOnly access token.
async function register() {
  const email = `verify-${Date.now()}@test.local`;
  const r = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "verify-password-1", display_name: "Verify" }),
  });
  assert(r.status === 200, `register failed ${r.status}`);
  const setCookie = r.headers.get("set-cookie") || "";
  const m = setCookie.match(/access_token=([^;]+)/);
  assert(m, "register did not return access_token cookie");
  return { token: decodeURIComponent(m[1]), email };
}

async function json(tok, url, opts = {}, method = "GET") {
  const res = await fetch(API + url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...opts.extra,
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  const { token } = await register();
  console.log("[1] registered (token captured)");

  console.log("[2] verify numbered rows gutter + add button (headless DOM)");
  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  // Navigate while injecting the access cookie for this user.
  await page.context().addCookies([{ name: "access_token", value: token, url: FRONT }]);
  await page.goto(`${FRONT}/`);
  await page.waitForLoadState("networkidle").catch(() => {});

  await page.getByText("Rows", { exact: true }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const rowsHeader = page.getByText("Rows", { exact: true });
  assert((await rowsHeader.count()) > 0, "expected a 'Rows' gutter header");
  const addRowBtn = page.locator('button[title="Add a new timeline row"]');
  assert((await addRowBtn.count()) > 0, "expected a tiny + row-adder button");

  // Click the + to add a numbered row, then assert a new numbered row appears.
  await addRowBtn.click();
  await page.waitForTimeout(1200);
  const rowCount = await page.locator("text=/^[1-9]$/").count();
  assert(rowCount >= 1, "expected at least one numbered row cell after adding");
  console.log("      rows gutter present; numbered row added");

  console.log("[3] create broad task + call breakdown (API truth)");
  const created = await json(token, "/tasks/", {
    body: { title: "Build a new website", description: "- Research\n- Define goals\n- Build roadmap", status: "todo" },
  }, "POST");
  assert(created.status === 200, `create task failed ${created.status}`);
  const taskId = created.body.id;

  const bd = await json(token, `/tasks/${taskId}/breakdown`, { body: {} }, "POST");
  assert(bd.status === 200, `breakdown failed ${bd.status}`);
  const subtasks = bd.body.subtasks || [];
  assert(subtasks.length >= 3, `expected >=3 subtasks, got ${subtasks.length}`);
  const titles = subtasks.map((s) => s.title);
  assert(titles.includes("Research"), `expected 'Research' subtask, got ${JSON.stringify(titles)}`);
  console.log("      breakdown subtasks:", titles);

  const subs = await json(token, `/tasks/${taskId}/subtasks`);
  assert(subs.status === 200 && subs.body.length === subtasks.length, "subtasks not persisted as children");
  console.log("      subtasks persisted as children");

  console.log("[4] verify tag assignment (API truth)");
  const tag = await json(token, "/tags/", { body: { name: "verify-tag-" + Date.now(), color: "#4fc3f7" } }, "POST");
  assert(tag.status === 200, `create tag failed ${tag.status}`);
  const tagId = tag.body.id;
  const assigned = await json(token, `/tags/tasks/${taskId}?tag_id=${tagId}`, {}, "POST");
  assert(assigned.status === 200, `assign tag failed ${assigned.status}`);
  const tagsOnTask = await json(token, `/tags/tasks/${taskId}`);
  assert(tagsOnTask.body.length === 1 && tagsOnTask.body[0].id === tagId, "tag not reflected on task");
  console.log("      tag assigned and reflected on task");

  await browser.close();
  console.log("VERIFY PASS: rows UI + breakdown (creates/persists subtasks) + tag assignment");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
