#!/usr/bin/env node
/**
 * Marketing link checker (deterministic, no browser).
 *
 * The nav and footer hrefs live in the EE marketing Shell/constants, and the
 * Downloads page builds its own CTAs. Rather than parse those private files,
 * this loads every public marketing page and checks each internal link that is
 * actually rendered, which catches a nav/footer/CTA link that points at a route
 * that does not exist (a 404).
 *
 * Usage: BASE_URL=http://localhost:3000 node scripts/smoke/marketing-links-smoke.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const PAGES = [
  "/",
  "/marketing",
  "/pricing",
  "/about",
  "/contact",
  "/mcp",
  "/marketing/features",
  "/marketing/changelog",
  "/marketing/downloads",
  "/marketing/legal",
  "/marketing/faq",
  "/privacy-policy",
  "/terms-of-service",
  "/cookie-policy",
  "/marketing/use-cases",
  "/marketing/vs",
  "/marketing/learn",
];

function extractInternalHrefs(html) {
  const re = /href="(\/[^"#?]*)"/g;
  const set = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (href.startsWith("//") || href.startsWith("/_next/") || href.startsWith("/api/")) continue;
    set.add(href);
  }
  return set;
}

async function main() {
  const links = new Set();
  for (const page of PAGES) {
    const res = await fetch(`${BASE_URL}${page}`);
    if (!res.ok) throw new Error(`${page} responded ${res.status}`);
    for (const href of extractInternalHrefs(await res.text())) links.add(href);
  }

  const failures = [];
  for (const href of [...links].sort()) {
    const res = await fetch(`${BASE_URL}${href}`, { redirect: "follow" });
    if (res.status >= 400) failures.push(`${res.status} ${href}`);
  }

  console.log(`Checked ${links.size} internal links from ${PAGES.length} marketing pages.`);
  if (failures.length > 0) {
    console.error("Broken links:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nSMOKE MARKETING LINKS PASS: every rendered internal link resolves");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
