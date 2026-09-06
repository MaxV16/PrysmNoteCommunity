// Repo-root convenience wrapper for building the Electron desktop apps.
//   npm run build:desktop -- --mac    (or --win / --linux / --dir)
// Steps: build the frontend standalone output, copy static assets + public into
// it (the standalone server does not serve them by itself), then run
// electron-builder from ee/apps/desktop. Installers land in
// ee/apps/desktop/release.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv.slice(2).find((a) => /^--(mac|win|linux|dir)$/.test(a));
const target = targetArg ? targetArg.slice(2) : null;

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`\n[build:desktop] failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

console.log("[build:desktop] 1/3 building frontend standalone…");
run("npm", ["run", "build"], root);

const standalone = path.join(root, "apps/frontend/.next/standalone");
const staticSrc = path.join(root, "apps/frontend/.next/static");
const publicSrc = path.join(root, "apps/frontend/public");
if (!existsSync(standalone)) {
  console.error("[build:desktop] standalone output missing - build did not produce .next/standalone");
  process.exit(1);
}

console.log("[build:desktop] 2/3 copying static + public into standalone…");
cpSync(staticSrc, path.join(standalone, ".next/static"), { recursive: true });
cpSync(publicSrc, path.join(standalone, "public"), { recursive: true });

console.log("[build:desktop] 3/3 running electron-builder" + (target ? ` --${target}` : "") + "…");
run(
  "npx",
  ["electron-builder", ...(target ? [`--${target}`] : [])],
  path.join(root, "ee/apps/desktop")
);
console.log("[build:desktop] done - see ee/apps/desktop/release/");