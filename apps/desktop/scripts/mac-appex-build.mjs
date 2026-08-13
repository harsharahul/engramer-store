#!/usr/bin/env node
/**
 * Builds the macOS File Provider extension: xcodegen over
 * macos/targets.yml, the real version stamped into the generated
 * Info.plist, an unsigned xcodebuild (mac-release.mjs signs exactly
 * once, after embedding), and the product copied to
 * <cargo target dir>/mac-appex/EngramFilesMac.appex where the release
 * script picks it up.
 *
 * Run from apps/desktop:  node scripts/mac-appex-build.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const tauriDir = join(desktopDir, "src-tauri");

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: desktopDir, stdio: "inherit", ...options });
const capture = (cmd, args) => execFileSync(cmd, args, { cwd: desktopDir, encoding: "utf8" });

// The same authority mac-release.mjs uses: cargo names the target dir;
// assuming a path once signed a stale month-old artifact.
const targetDir = JSON.parse(
  capture("cargo", [
    "metadata", "--no-deps", "--format-version", "1",
    "--manifest-path", join(tauriDir, "Cargo.toml"),
  ]),
).target_directory;

// The core must carry a macOS slice before anything here can link.
const framework = join(tauriDir, "ios", "EngramCore.xcframework");
if (!existsSync(join(framework, "macos-arm64_x86_64"))) {
  console.log("mac-appex: EngramCore.xcframework has no macOS slice yet; building the core");
  run("node", [join(here, "apple-core-build.mjs")]);
}

// The project generates into the spec's own directory: xcodegen writes
// generated files spec-relative but references them project-relative,
// and the two frames only agree when spec and project share a home.
const projectDir = join(tauriDir, "macos");
mkdirSync(projectDir, { recursive: true });
run("xcodegen", [
  "generate",
  "--spec", join(tauriDir, "macos", "targets.yml"),
  "--project", projectDir,
]);

// Version numbers are real, not "0.0.0": the appex inside a release
// must say what the app says.
const version = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")).version;
const plist = join(tauriDir, "macos", "gen-mac", "EngramFilesMac-Info.plist");
run("plutil", ["-replace", "CFBundleShortVersionString", "-string", version, plist]);
run("plutil", ["-replace", "CFBundleVersion", "-string", version, plist]);

const symroot = join(targetDir, "mac-appex-sym");
run("xcodebuild", [
  "-project", join(projectDir, "EngramMacExtensions.xcodeproj"),
  "-target", "EngramFilesMac",
  "-configuration", "Release",
  "-sdk", "macosx",
  `SYMROOT=${symroot}`,
  "CODE_SIGNING_ALLOWED=NO",
  "build",
]);

const product = join(symroot, "Release", "EngramFilesMac.appex");
if (!existsSync(product)) {
  console.error("mac-appex: xcodebuild finished but left no appex");
  process.exit(1);
}
const out = join(targetDir, "mac-appex");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(product, join(out, "EngramFilesMac.appex"), { recursive: true });
console.log(`mac-appex: ready at ${join(out, "EngramFilesMac.appex")}`);
