#!/usr/bin/env node
/**
 * Re-encodes the shipped PNG icons in place: strips every metadata chunk and
 * applies maximum PNG compression. Reproducible so the step can be re-run after
 * a new source icon is dropped in.
 *
 * The favicon/apple-touch/PWA icons intentionally stay PNG (WebP is not a valid
 * `<link rel="icon">` for every browser). The Next.js file-convention duplicates
 * (src/app/icon.png, src/app/apple-icon.png) were removed; layout.tsx metadata
 * points at the single source in public/.
 *
 * Usage (from the repo root): node scripts/optimize-icons.mjs
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();

const ICONS = [
  "apps/frontend/public/icons/icon-512.png",
  "apps/frontend/public/icons/icon-192.png",
  "apps/frontend/public/icons/apple-touch-icon.png",
  "apps/frontend/public/prysm-icon.png",
];

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function optimize(rel) {
  const file = path.join(ROOT, rel);
  const before = (await stat(file)).size;
  const src = await readFile(file);
  const out = await sharp(src)
    .png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true })
    .toBuffer();
  if (out.length >= before) {
    console.log(`  ${rel}: already optimal (${kb(before)})`);
    return;
  }
  await writeFile(file, out);
  const pct = ((1 - out.length / before) * 100).toFixed(0);
  console.log(`  ${rel}: ${kb(before)} -> ${kb(out.length)} (-${pct}%)`);
}

console.log("Optimizing icons (metadata stripped, max PNG compression)...");
for (const rel of ICONS) {
  await optimize(rel);
}
console.log("Done.");
