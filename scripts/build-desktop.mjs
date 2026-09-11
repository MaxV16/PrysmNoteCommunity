// Builds the Electron desktop apps without bundling the frontend.
// The packaged app loads https://prysmnote.com live (like the mobile app).
//   npm run build:desktop -- --mac    (or --win / --linux / --dir)
// Installers land in ee/apps/desktop/release.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv.slice(2).find((a) => /^--(mac|win|linux|dir)$/.test(a));
const target = targetArg ? targetArg.slice(2) : null;

console.log("[build:desktop] running electron-builder" + (target ? ` --${target}` : "") + "…");
spawnSync(
  "npx",
  ["electron-builder", ...(target ? [`--${target}`] : [])],
  { cwd: path.join(root, "ee/apps/desktop"), stdio: "inherit", shell: process.platform === "win32" }
);
console.log("[build:desktop] done - see ee/apps/desktop/release/");
