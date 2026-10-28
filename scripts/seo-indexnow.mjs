#!/usr/bin/env node
/**
 * Tell IndexNow (Bing, Yandex, Seznam, Naver) that the pages exist.
 *
 * Google has no open "please crawl this" endpoint that works without a service
 * account, but Bing powers a large share of non-Google search and DuckDuckGo, and
 * IndexNow is a plain HTTPS POST: no account, no key rotation, no quota paperwork.
 *
 * The key has to be reachable at the site root as `<key>.txt` containing the key
 * itself, which is why the file lives in `apps/frontend/public/`. Changing the key
 * means adding the new file and passing `--key` here; the old file can stay.
 *
 *   node scripts/seo-indexnow.mjs                       # submit the sitemap
 *   node scripts/seo-indexnow.mjs --dry                 # print what would be sent
 *   node scripts/seo-indexnow.mjs --urls /a /b          # submit specific paths
 *   SITE=https://prysmnote.com node scripts/seo-indexnow.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "apps", "frontend", "public");
const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH = 1000;

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const explicitUrls = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--urls") {
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j += 1) {
      explicitUrls.push(args[j]);
      i = j;
    }
  }
}
const site = (process.env.SITE || "https://prysmnote.com").replace(/\/$/, "");
const host = new URL(site).host;

/** The key file is the one public .txt whose name is a long hex string. */
function findKey() {
  const named = args.find((a) => a.startsWith("--key="));
  if (named) return named.slice("--key=".length);
  for (const entry of readdirSync(PUBLIC_DIR)) {
    if (!entry.endsWith(".txt")) continue;
    const stem = entry.slice(0, -4);
    if (!/^[a-f0-9]{16,128}$/i.test(stem)) continue;
    const body = readFileSync(path.join(PUBLIC_DIR, entry), "utf8").trim();
    if (body === stem) return stem;
  }
  throw new Error(
    `no IndexNow key file found in ${PUBLIC_DIR} (expected <key>.txt containing the key)`
  );
}

async function sitemapUrls() {
  const res = await fetch(`${site}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap answered ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function send(urls) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `${site}/${key}.txt`,
      urlList: urls,
    }),
  });
  // 200 means accepted, 202 means accepted but the key is still being checked.
  if (res.status !== 200 && res.status !== 202) {
    const detail = await res.text().catch(() => "");
    throw new Error(`IndexNow answered ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.status;
}

const key = findKey();
const urls = explicitUrls.length
  ? explicitUrls.map((u) => (u.startsWith("http") ? u : `${site}${u.startsWith("/") ? "" : "/"}${u}`))
  : await sitemapUrls();

if (!urls.length) {
  console.error("nothing to submit: the sitemap listed no URLs");
  process.exit(1);
}

console.log(`indexnow: ${urls.length} urls for ${host}, key ${key.slice(0, 8)}...`);
if (dry) {
  console.log(urls.slice(0, 5).join("\n"));
  console.log("dry run, nothing sent");
  process.exit(0);
}

let submitted = 0;
for (let i = 0; i < urls.length; i += BATCH) {
  const batch = urls.slice(i, i + BATCH);
  const status = await send(batch);
  submitted += batch.length;
  console.log(`  ${batch.length} urls -> ${status}`);
}
console.log(`indexnow: submitted ${submitted} urls`);
