#!/usr/bin/env node
// Regenerates the checked-in word-set artifacts from scripts/words.txt:
//   - apps/frontend/src/lib/common-words.ts    (packed string + Set)
//   - apps/backend/app/services/common_words.py (frozenset)
//
// Usage: node scripts/gen-common-words.mjs
//
// Source of truth: scripts/words.txt - sorted, lowercase, one word per line.
// It was generated during implementation from "The Oxford 3000" frequency list
// (Apache-2.0, repo github.com/ittuann/The-Oxford-5000-Word-Lists), filtered to
// plain a-z words, trimmed to ~3k, plus app terms and recent derived forms.
//
// Hygiene rules (kept here so regeneration is deterministic and safe):
//   - The set must NOT contain short names that collide with split-word
//     fragments (tom, fin, lo) or joins silently stop working.
//   - The corpus target words (prysm, prysmnote, tomorrow, finance, expenses,
//     loans, deleting, cancelled, following, feature, settings, project,
//     varies) plus a small set of derived *ing/*ed/*s forms must always be
//     present so the word-rejoin rule can repair the observed QA artifacts.
//
// The word set is core (not EE): formatting applies to every build, and the
// outputs are deterministic given words.txt, so they are safe to check in.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WORDS_FILE = path.join(__dirname, "words.txt");
const TS_OUT = path.join(ROOT, "apps/frontend/src/lib/common-words.ts");
const PY_OUT = path.join(ROOT, "apps/backend/app/services/common_words.py");

const EXCLUDED = new Set(["tom", "fin", "lo"]);

const TARGET_EXTRA = [
  "prysm",
  "prysmnote",
  "delete",
  "deleted",
  "deleting",
  "deletion",
  "expenses",
  "loans",
  "cancelled",
  "canceled",
  "settings",
  "varies",
  "tracks",
  "tracked",
  "tracking",
  "manages",
  "managed",
  "managing",
];

const TS_HEADER = [
  "// GENERATED FILE - DO NOT EDIT BY HAND.",
  "// Regenerate with: node scripts/gen-common-words.mjs",
  "// Source: scripts/words.txt (Oxford 3000, Apache-2.0) - see that script",
  "// for the exact source, filtering, hygiene exclusions and app-term additions.",
].join("\n");

const PY_HEADER = [
  "# GENERATED FILE - DO NOT EDIT BY HAND.",
  "# Regenerate with: node scripts/gen-common-words.mjs",
  "# Source: scripts/words.txt (Oxford 3000, Apache-2.0) - see that script",
  "# for the exact source, filtering, hygiene exclusions and app-term additions.",
].join("\n");

function fail(msg) {
  console.error(`gen-common-words: ${msg}`);
  process.exit(1);
}

function wrapWords(words, perLine) {
  const lines = [];
  for (let i = 0; i < words.length; i += perLine) {
    lines.push(words.slice(i, i + perLine).join(" "));
  }
  return lines;
}

const raw = fs.readFileSync(WORDS_FILE, "utf8");
let words = raw
  .split(/\r?\n/)
  .map((w) => w.trim())
  .filter((w) => /^[a-z]+$/.test(w));
words = [...new Set(words)];
words.sort();

for (const bad of EXCLUDED) {
  if (words.includes(bad)) {
    fail(`words.txt contains a hygiene-excluded fragment: ${bad}`);
  }
}
for (const target of TARGET_EXTRA) {
  if (!words.includes(target)) {
    fail(`words.txt is missing required target word: ${target}`);
  }
}

// --- TypeScript module (packed space-separated string + lazy Set) ---
const tsPacked = words.join(" ");
const tsBody = [
  TS_HEADER,
  "",
  "function buildSet(): ReadonlySet<string> {",
  `  return new Set("${tsPacked}".split(" "));`,
  "}",
  "",
  "let _commonWords: ReadonlySet<string> | null = null;",
  "export function commonWords(): ReadonlySet<string> {",
  "  if (!_commonWords) _commonWords = buildSet();",
  "  return _commonWords;",
  "}",
  "",
  `export const COMMON_WORDS: ReadonlySet<string> = commonWords();`,
  "",
].join("\n");
fs.writeFileSync(TS_OUT, `${tsBody}`);

// --- Python module (frozenset literal) ---
const pyLines = [PY_HEADER, "", '"""Common English words used by AI text clean-up (word-split rejoin)."""', "", "COMMON_WORDS = frozenset({"];
for (const line of wrapWords(words, 10)) {
  pyLines.push(`    ${line
    .split(" ")
    .map((w) => `"${w}"`)
    .join(", ")},`);
}
pyLines.push("})", "");
fs.writeFileSync(PY_OUT, pyLines.join("\n"));

console.log(
  `gen-common-words: wrote ${words.length} words -> common-words.ts (${fs.statSync(TS_OUT).size} bytes), common_words.py (${fs.statSync(PY_OUT).size} bytes)`
);