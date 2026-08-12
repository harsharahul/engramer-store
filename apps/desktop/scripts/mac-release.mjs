#!/usr/bin/env node
/**
 * Builds, signs, notarizes and staples the Mac app, ending in a DMG a
 * stranger's Mac opens without ceremony.
 *
 * The order is the point. One tauri build emits only the bare .app; the
 * extension (once it exists) and the provisioning profile go into the
 * bundle BEFORE anything is signed, signing runs inside out (extension
 * first, then the app), the app is notarized and stapled on its own,
 * and only then is the DMG built around it, signed, notarized and
 * stapled itself. Signing after modifying, never modifying after
 * signing; the committed configuration never signs, so dev builds are
 * untouched.
 *
 *   ENGRAM_APP_URL=https://vault.example.com \
 *   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
 *   ENGRAM_MAC_APP_PROFILE=~/secrets/engram-mac/engram-mac-app.provisionprofile \
 *   pnpm --filter @engramer/desktop mac:release
 *
 * Optional: APPLE_DEVELOPMENT_TEAM (else parsed from the identity),
 * ENGRAM_MAC_FILES_PROFILE (the extension's profile, once the macOS
 * extension target exists), APPLE_NOTARY_PROFILE (default
 * "engram-notary", the notarytool keychain profile name).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const tauriDir = join(desktopDir, "src-tauri");

function fail(message) {
  console.error(`mac-release: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const shown = [command, ...args].join(" ");
  console.log(`mac-release: ${shown}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: desktopDir, ...options });
  if (result.status !== 0) {
    fail(`failed (${result.status}): ${shown}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: desktopDir });
  if (result.status !== 0) {
    fail(`failed (${result.status}): ${[command, ...args].join(" ")}\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

const expand = (p) => (p ? p.replace(/^~(?=\/)/, homedir()) : p);

// ----- preflight: everything named before anything is built -----

const appUrl = (process.env.ENGRAM_APP_URL ?? "").trim();
if (!appUrl.startsWith("https://")) {
  fail("set ENGRAM_APP_URL=https://your-vault; a localhost bake is a blank screen");
}
const identity = (process.env.APPLE_SIGNING_IDENTITY ?? "").trim();
if (!identity.includes("Developer ID Application")) {
  fail('set APPLE_SIGNING_IDENTITY to the full "Developer ID Application: ..." identity');
}
const team = (process.env.APPLE_DEVELOPMENT_TEAM ?? identity.match(/\(([A-Z0-9]{10})\)$/)?.[1] ?? "").trim();
if (!team) {
  fail("could not read the team id from the identity; set APPLE_DEVELOPMENT_TEAM");
}
const appProfile = expand((process.env.ENGRAM_MAC_APP_PROFILE ?? "").trim());
if (!appProfile || !existsSync(appProfile)) {
  fail("set ENGRAM_MAC_APP_PROFILE to the app's Developer ID provisioning profile");
}
const filesProfile = expand((process.env.ENGRAM_MAC_FILES_PROFILE ?? "").trim());
const notaryProfile = (process.env.APPLE_NOTARY_PROFILE ?? "engram-notary").trim();

const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const version = config.version;
const appName = `${config.productName}.app`;
// Ask cargo where builds actually land: the crate lives in a workspace,
// so the bundle is under the WORKSPACE target dir, not src-tauri/target.
// Assuming the latter once signed a stale month-old app.
const targetDir = JSON.parse(
  capture("cargo", [
    "metadata", "--no-deps", "--format-version", "1",
    "--manifest-path", join(tauriDir, "Cargo.toml"),
  ]),
).target_directory;
const bundleDir = join(targetDir, "release", "bundle", "macos");
const appPath = join(bundleDir, appName);
const workDir = join(targetDir, "mac-release");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// codesign does not expand Xcode's $(AppIdentifierPrefix); resolve the
// committed, builder-neutral entitlements with the real prefix.
function resolveEntitlements(name) {
  const source = readFileSync(join(tauriDir, "macos", name), "utf8");
  const resolved = source.replaceAll("$(AppIdentifierPrefix)", `${team}.`);
  const path = join(workDir, name);
  writeFileSync(path, resolved);
  return path;
}
const appEntitlements = resolveEntitlements("app.entitlements");
const appexEntitlements = resolveEntitlements("appex.entitlements");

// ----- build the extension first, then the app -----

const appexBuilder = join(here, "mac-appex-build.mjs");
let appexPath = null;
if (existsSync(join(tauriDir, "macos", "targets.yml")) && existsSync(appexBuilder)) {
  run("node", [appexBuilder]);
  appexPath = join(targetDir, "mac-appex", "EngramFilesMac.appex");
  if (!existsSync(appexPath)) {
    fail("the extension build reported success but left no appex");
  }
} else {
  console.log("mac-release: no macOS extension target yet; building the bare app");
}

// The bundler must not sign: the bundle is modified after it runs, and
// two signing authorities is how a step gets skipped silently.
const buildEnv = { ...process.env };
delete buildEnv.APPLE_SIGNING_IDENTITY;
run("node", [join(here, "instance-config.mjs")], { env: buildEnv });
run("pnpm", ["exec", "tauri", "build", "--config", "src-tauri/tauri.instance.json", "--bundles", "app"], {
  env: buildEnv,
});
if (!existsSync(appPath)) {
  fail(`tauri build left no app at ${appPath}`);
}
const builtVersion = capture("plutil", [
  "-extract", "CFBundleShortVersionString", "raw",
  join(appPath, "Contents", "Info.plist"),
]).trim();
if (builtVersion !== version) {
  fail(`the app at ${appPath} is ${builtVersion}, not ${version}; a stale build is in the way`);
}

// ----- assemble: profile and extension go in before any signature -----

copyFileSync(appProfile, join(appPath, "Contents", "embedded.provisionprofile"));
if (appexPath) {
  if (!filesProfile || !existsSync(filesProfile)) {
    fail("the extension is built; set ENGRAM_MAC_FILES_PROFILE to its provisioning profile");
  }
  const plugins = join(appPath, "Contents", "PlugIns");
  mkdirSync(plugins, { recursive: true });
  run("cp", ["-R", appexPath, plugins]);
  const embedded = join(plugins, "EngramFilesMac.appex");
  copyFileSync(filesProfile, join(embedded, "Contents", "embedded.provisionprofile"));
  run("codesign", [
    "--force", "--options", "runtime", "--timestamp",
    "--entitlements", appexEntitlements, "--sign", identity, embedded,
  ]);
}

// ----- sign inside out, then prove the signature says what it must -----

const frameworks = join(appPath, "Contents", "Frameworks");
if (existsSync(frameworks)) {
  for (const entry of capture("ls", [frameworks]).split("\n").filter(Boolean)) {
    run("codesign", [
      "--force", "--options", "runtime", "--timestamp", "--sign", identity,
      join(frameworks, entry),
    ]);
  }
}
run("codesign", [
  "--force", "--options", "runtime", "--timestamp",
  "--entitlements", appEntitlements, "--sign", identity, appPath,
]);
run("codesign", ["--verify", "--strict", "--verbose=2", appPath]);

const sealed = capture("codesign", ["-d", "--entitlements", ":-", appPath]);
if (!sealed.includes(`${team}.com.harsharahul.engramstore`)) {
  fail("the signed app does not carry the keychain access group; refusing to notarize");
}
if (appexPath) {
  const appexSealed = capture("codesign", [
    "-d", "--entitlements", ":-", join(appPath, "Contents", "PlugIns", "EngramFilesMac.appex"),
  ]);
  if (!appexSealed.includes("com.apple.security.app-sandbox")) {
    fail("the signed extension lost its sandbox entitlement; refusing to notarize");
  }
}

// ----- notarize the app, staple it, and only then wrap the DMG -----

function notarize(path, what) {
  const output = capture("xcrun", [
    "notarytool", "submit", path,
    "--keychain-profile", notaryProfile, "--wait", "--output-format", "json",
  ]);
  let verdict;
  try {
    verdict = JSON.parse(output);
  } catch {
    fail(`notarytool returned something unreadable for the ${what}: ${output}`);
  }
  console.log(`mac-release: notarization of the ${what}: ${verdict.status} (${verdict.id})`);
  if (verdict.status !== "Accepted") {
    run("xcrun", ["notarytool", "log", verdict.id, "--keychain-profile", notaryProfile]);
    fail(`Apple refused the ${what}; the log above says why`);
  }
}

const appZip = join(workDir, "Engram Store.zip");
run("ditto", ["-c", "-k", "--keepParent", appPath, appZip]);
notarize(appZip, "app");
run("xcrun", ["stapler", "staple", appPath]);

const arch = process.arch === "arm64" ? "aarch64" : "x64";
const dmgPath = join(bundleDir, `${config.productName}_${version}_${arch}.dmg`);
const staging = join(workDir, "dmg");
mkdirSync(staging, { recursive: true });
run("cp", ["-R", appPath, staging]);
symlinkSync("/Applications", join(staging, "Applications"));
rmSync(dmgPath, { force: true });
run("hdiutil", ["create", "-volname", config.productName, "-srcfolder", staging, "-format", "UDZO", dmgPath]);
run("codesign", ["--timestamp", "--sign", identity, dmgPath]);
notarize(dmgPath, "DMG");
run("xcrun", ["stapler", "staple", dmgPath]);

// ----- the proofs a stranger's Mac will run -----

run("xcrun", ["stapler", "validate", appPath]);
run("xcrun", ["stapler", "validate", dmgPath]);
run("spctl", ["-a", "-vvv", "-t", "exec", appPath]);
run("shasum", ["-a", "256", dmgPath]);
console.log(`mac-release: done: ${dmgPath}`);
