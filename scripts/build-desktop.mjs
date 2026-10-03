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
import fs from "node:fs";

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

// macOS native passkeys (Touch ID): Electron only services platform-authenticator
// WebAuthn requests after app.configureWebAuthn() is called with a keychain access
// group that the signing entitlements allow. Both are derived from the Apple Team
// ID, so we generate them only for a signed macOS build; unsigned/dev builds keep
// the base entitlements and fall back to the system browser. main.js reads
// electron/webauthn.json at runtime.
const electronDir = path.join(root, "ee/apps/desktop/electron");
const webauthnConfigPath = path.join(electronDir, "webauthn.json");
const webauthnEntitlementsPath = path.join(root, "ee/apps/desktop/build", "entitlements.webauthn.mac.plist");
const appleTeamId = (process.env.APPLE_TEAM_ID || "").trim();
if (isMacBuild && appleTeamId) {
  const keychainAccessGroup = `${appleTeamId}.com.prysmnote.app.webauthn`;
  fs.writeFileSync(
    webauthnConfigPath,
    `${JSON.stringify({ keychainAccessGroup, promptReason: "verify your identity for Prysm Note" }, null, 2)}\n`
  );
  const baseEntitlements = fs.readFileSync(
    path.join(root, "ee/apps/desktop/build", "entitlements.mac.plist"),
    "utf8"
  );
  const webauthnEntitlements = baseEntitlements.replace(
    "</dict>",
    `  <key>keychain-access-groups</key>\n  <array>\n    <string>${keychainAccessGroup}</string>\n  </array>\n</dict>`
  );
  fs.writeFileSync(webauthnEntitlementsPath, webauthnEntitlements);
  ebArgs.push(`-c.mac.entitlements=${webauthnEntitlementsPath}`);
  ebArgs.push(`-c.mac.entitlementsInherit=${webauthnEntitlementsPath}`);
  console.log(`[build:desktop] enabling macOS passkeys with keychain group ${keychainAccessGroup}`);
} else {
  // A generated config from a previous signed build must never leak into an
  // unsigned build (main.js would try to use a group the entitlements forbid).
  try {
    fs.rmSync(webauthnConfigPath, { force: true });
  } catch {}
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
