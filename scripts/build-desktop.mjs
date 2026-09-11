// Builds the Electron desktop apps with the hosted API baked in.
// The packaged app bundles a Next.js standalone server on 127.0.0.1:3200, so
// NEXT_PUBLIC_API_URL must point at the hosted backend (https://prysmnote.com/api)
// rather than the default relative "/api" (which would resolve to the local port).
//   npm run build:desktop -- --mac    (or --win / --linux / --dir)
// Installers land in ee/apps/desktop/release.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv.slice(2).find((a) => /^--(mac|win|linux|dir)$/.test(a));
const target = targetArg ? targetArg.slice(2) : null;

// Bake the hosted API into the standalone build. Keep NEXT_PUBLIC_GIT_SHA
// whatever the parent env says (unset in dev = no update banner).
const env = { ...process.env, NEXT_PUBLIC_API_URL: "https://prysmnote.com/api" };

console.log("[build:desktop] building frontend standalone with NEXT_PUBLIC_API_URL=" + env.NEXT_PUBLIC_API_URL);
const build = spawnSync("npm", ["run", "build"], { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) {
  console.error("[build:desktop] frontend build failed - aborting desktop packaging");
  process.exit(build.status || 1);
}

// Copy static + public assets into the standalone output so routes/assets resolve.
const standaloneDir = path.join(root, "apps/frontend/.next/standalone");
const staticDir = path.join(root, "apps/frontend/.next/static");
const publicDir = path.join(root, "apps/frontend/public");
if (fs.existsSync(standaloneDir)) {
  if (fs.existsSync(staticDir)) {
    fs.cpSync(staticDir, path.join(standaloneDir, ".next/static"), { recursive: true });
  }
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(standaloneDir, "public"), { recursive: true });
  }
  console.log("[build:desktop] standalone assets copied");
} else {
  console.warn("[build:desktop] .next/standalone not found; packaging may contain no bundled server");
}

console.log("[build:desktop] running electron-builder" + (target ? ` --${target}` : "") + " (publish disabled: metadata is written, but uploads are handled by the release pipeline)...");
const eb = spawnSync(
  "npx",
  ["electron-builder", ...(target ? [`--${target}`] : []), "--publish", "never"],
  { cwd: path.join(root, "ee/apps/desktop"), env, stdio: "inherit", shell: process.platform === "win32" }
);
if (eb.status !== 0) {
  console.error("[build:desktop] electron-builder failed");
  process.exit(eb.status || 1);
}
console.log("[build:desktop] done - see ee/apps/desktop/release/");