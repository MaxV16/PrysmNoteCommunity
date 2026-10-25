#!/usr/bin/env node
// Grep gate for the design system documented in apps/frontend/DESIGN.md.
// It catches retired patterns that are easy to paste back in. Run: npm run ui:audit

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "apps/frontend/src");

// Files whose hex values are content or brand colors, not surface styling.
const HEX_ALLOW = new Set([
  "app/layout.tsx",
  "app/settings/page.tsx",
  "components/auth/OAuthButtons.tsx",
  "components/board/board-utils.ts",
  "components/settings/ThemeTokenImport.tsx",
  "components/sidebar/ThemeMenu.tsx",
  "ee/lib/risk-collector.ts",
  "ee/marketing/demo/sampleData.ts",
  "lib/celebrate.ts",
  "lib/notes.ts",
  "lib/palette.ts",
  "lib/priority.ts",
  "lib/theme-context.tsx",
  "lib/theme-import.ts",
]);

const RULES = [
  {
    id: "glass-blur",
    test: /backdrop-blur/,
    message: "glass blur is retired. Use a solid bg-surface / bg-elevated surface.",
  },
  {
    id: "shadow-2xl",
    test: /shadow-2xl/,
    message: "only two elevation levels exist. Use shadow-md or shadow-lg.",
  },
  {
    id: "radius-2xl",
    test: /rounded-2xl/,
    message: "the surface radius scale stops at rounded-xl (12px).",
  },
  {
    id: "legacy-indigo",
    test: /#6366f1|#5b5bd6/i,
    message: "legacy indigo accent found. Use var(--accent) or a token.",
  },
  {
    id: "em-dash",
    test: /\u2014/,
    message: "em dashes are banned in this repo. Use a comma, colon or hyphen.",
  },
  {
    id: "raw-hex",
    test: /#[0-9a-fA-F]{6}\b/,
    message: "raw hex color in a component. Add a token instead.",
    skip: (rel) => HEX_ALLOW.has(rel) || /\.(test|spec)\.(ts|tsx)$/.test(rel),
  },
];

const CODE_FILE = /\.(ts|tsx)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (CODE_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const failures = [];

for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file).split("\\").join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.skip && rule.skip(rel)) continue;
      if (!rule.test.test(line)) continue;
      failures.push({ file: rel, line: index + 1, id: rule.id, message: rule.message });
    }
  });
}

if (failures.length === 0) {
  console.log("ui:audit PASS: no retired design patterns found.");
  process.exit(0);
}

console.error(`ui:audit FAIL: ${failures.length} issue(s)\n`);
for (const failure of failures) {
  console.error(`  apps/frontend/src/${failure.file}:${failure.line}  [${failure.id}]`);
  console.error(`    ${failure.message}`);
}
console.error("\nSee apps/frontend/DESIGN.md for the rules and the token names.");
process.exit(1);
