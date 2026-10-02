// Builds the Electron desktop apps.
//
// The packaged app loads the live site at https://prysmnote.com (see
// electron/main.js), so no frontend bundle is packaged: the app payload is just
// electron/** + package.json (see electron-builder.yml). There is no bundled
// local server.
//   npm run build:desktop -- --mac    (or --win / --linux / --dir)
// Installers land in ee/apps/desktop/release.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv.slice(2).find((a) => /^--(mac|win|linux|dir)$/.test(a));
const target = targetArg ? targetArg.slice(2) : null;
const isMacBuild = process.platform === "darwin" && (!target || target === "mac");

// GitHub maps an ABSENT secret to an EMPTY STRING, not "unset", and
// electron-builder then treats CSC_LINK="" as a certificate path: it resolves
// relative to the project dir and dies with "<project dir> not a file". Drop
// any signing variable that is present but blank so a credential-less CI run
// builds cleanly; real values pass through untouched.
const SIGNING_ENV = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN_PROFILE",
];
for (const name of SIGNING_ENV) {
  if (name in process.env && process.env[name].trim() === "") {
    delete process.env[name];
  }
}

// macOS signing policy:
// electron-builder only signs when a Developer ID certificate is available
// (CSC_LINK / CSC_NAME) and never falls back to ad-hoc signing on its own. An
// unsigned app bundle downloaded through a browser gets the quarantine flag and
// Gatekeeper reports it as "damaged and can't be opened". When no signing
// credentials exist, opt into ad-hoc signing explicitly so the bundle carries a
// real signature (not just the linker's implicit one). Notarization runs
// automatically whenever the APPLE_* env vars are present.
const hasMacSigning = Boolean(
  process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.APPLE_ID ||
    process.env.APPLE_API_KEY ||
    process.env.APPLE_KEYCHAIN_PROFILE
);

const ebArgs = ["electron-builder", ...(target ? [`--${target}`] : []), "--publish", "never"];
if (isMacBuild && !hasMacSigning) {
  ebArgs.push("-c.mac.identity=-");
  console.log("[build:desktop] no macOS signing credentials - ad-hoc signing the app bundle");
}
console.log("[build:desktop] running electron-builder" + (target ? ` --${target}` : "") + " (publish disabled: metadata is written, but uploads are handled by the release pipeline)...");
const eb = spawnSync(
  "npx",
  ebArgs,
  { cwd: path.join(root, "ee/apps/desktop"), stdio: "inherit", shell: process.platform === "win32" }
);
if (eb.status !== 0) {
  console.error("[build:desktop] electron-builder failed");
  process.exit(eb.status || 1);
}

// The Gatekeeper workaround note is placed inside the DMG by electron-builder
// itself (mac.dmg.contents in electron-builder.yml), so the image is built once
// and its signature/blockmap stay valid. Do not post-process the DMG here.

console.log("[build:desktop] done - see ee/apps/desktop/release/");
