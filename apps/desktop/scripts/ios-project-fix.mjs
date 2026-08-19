#!/usr/bin/env node
/**
 * Repairs and extends the generated iOS Xcode project after
 * `tauri ios init`. Generation produces a single-target project with a
 * handful of defects; everything under gen/apple is derived and
 * git-ignored, so every change the project needs beyond generation is
 * re-applied here, idempotently, in a fixed order:
 *
 *  1. Merge the committed extension targets (ios/targets.yml) into the
 *     generated project.yml, and make the app embed them.
 *  2. Stamp the released version onto every target: generation bakes
 *     whatever version was current at init time, and an archive whose
 *     targets disagree about versions fails validation.
 *  3. Floor the deployment target at 16.0 (the Files provider's floor).
 *  4. Re-run xcodegen so the pbxproj reflects all of the above.
 *  5. Then the pbxproj repairs: drop libapp.a from Resources (App Store
 *     validation refuses bundled static libraries), floor stragglers.
 *  6. App entitlements, brand icons, privacy strings, as before.
 *  7. Verify every expected target exists, loudly: a silently missing
 *     target is the same failure class as a missing ACL entry.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, "..", "src-tauri");
const apple = join(tauriDir, "gen", "apple");
const project = join(apple, "engram-store-desktop.xcodeproj", "project.pbxproj");
const yml = join(apple, "project.yml");

// XcodeGen expands ${VAR} references from its environment while
// generating. The Rust build phase's script keeps a ${FORCE_COLOR}
// placeholder to be resolved at BUILD time; an inherited npm-style
// FORCE_COLOR here would be baked into the project as a bogus
// architecture argument and fail every archive.
const env = { ...process.env };
delete env.FORCE_COLOR;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "pipe", env }).toString();
const sips = (...args) => execFileSync("sips", args, { stdio: ["ignore", "pipe", "ignore"] });

try {
  run("xcodegen", ["--version"]);
} catch {
  console.error("ios project: xcodegen is required (brew install xcodegen)");
  process.exit(1);
}

// 1. Extension targets into project.yml. The generated file has exactly
// one `targets:` block; the committed fragment's targets append under it,
// and the app target gains the embed dependency.
const fragment = readFileSync(join(tauriDir, "ios", "targets.yml"), "utf8");
const extensionYaml = fragment.split(/^targets:\s*$/m)[1];
if (!extensionYaml) {
  console.error("ios project: ios/targets.yml has no targets block");
  process.exit(1);
}
let spec = readFileSync(yml, "utf8");
// tauri ios init keeps an existing gen/apple untouched, so a previous
// run's injected block may still be present and stale. The markers make
// the merge self-replacing: drop whatever was injected before, insert
// the current fragment.
spec = spec.replace(/# >>> engram extensions\n[\s\S]*?# <<< engram extensions\n/, "");
spec = spec.replace(
  /^targets:\s*$/m,
  `targets:\n# >>> engram extensions${extensionYaml.trimEnd()}\n# <<< engram extensions`,
);
if (!spec.includes("- target: EngramShare")) {
  // The APP target's dependencies gain the extension with embed, which
  // is what makes the Embed App Extensions phase appear. Anchored to the
  // app target's section: the first `dependencies:` in the file belongs
  // to the injected extension itself, and a naive match once made the
  // extension embed itself, recursively.
  const appAt = spec.indexOf("engram-store-desktop_iOS:");
  if (appAt < 0) {
    console.error("ios project: app target not found in project.yml");
    process.exit(1);
  }
  const head = spec.slice(0, appAt);
  const tail = spec.slice(appAt).replace(
    /^(\s*)dependencies:\s*$/m,
    `$1dependencies:\n$1  - target: EngramShare\n$1    embed: true\n$1  - target: EngramFiles\n$1    embed: true`,
  );
  spec = head + tail;
}

// 2 + 3. Version stamp and floor, across everything now in the spec.
// App Store Connect refuses a second upload with the same build
// number, so a re-upload of the SAME version names a higher build in
// the environment: ENGRAM_BUILD_NUMBER=0.46.0.2 ios:bundle.
const version = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")).version;
const build = (process.env.ENGRAM_BUILD_NUMBER ?? "").trim() || version;
spec = spec
  .replace(/CFBundleShortVersionString: .*/g, `CFBundleShortVersionString: ${version}`)
  .replace(/CFBundleVersion: .*/g, `CFBundleVersion: "${build}"`)
  .replace(/iOS: 1[45]\.0/g, "iOS: 16.0");
// The team applies project-wide so every target signs; generation only
// carries it when an instance config was present at init time, which a
// fresh checkout's init is not. The id is public (it is in the committed
// entitlements), so stamping it here is configuration, not a secret.
if (!spec.includes("DEVELOPMENT_TEAM")) {
  spec = spec.replace(
    /^settingGroups:/m,
    `settings:\n  base:\n    DEVELOPMENT_TEAM: "5MD7MFXN8S"\nsettingGroups:`,
  );
}
writeFileSync(yml, spec);
console.log(`ios project: targets merged, version stamped ${version}, floor 16.0, team set`);

// 4. Regenerate the pbxproj from the amended spec.
run("xcodegen", ["generate", "--spec", "project.yml", "--project", "."], apple);
console.log("ios project: xcodegen regenerated the project");

// 5. pbxproj repairs, on the regenerated file.
const before = readFileSync(project, "utf8");
const lines = before.split("\n");
// libapp.a as a bundled resource fails App Store validation; the
// extension's generated Info.plist as a resource collides with the
// plist-processing step (two producers of the same bundle file).
const kept = lines.filter(
  (line) => !line.includes("libapp.a in Resources") && !line.includes("Info.plist in Resources"),
);
if (kept.length < lines.length) {
  console.log(`ios project: dropped ${lines.length - kept.length} resource-copy defects`);
}
writeFileSync(
  project,
  kept
    .join("\n")
    .replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 14.0;", "IPHONEOS_DEPLOYMENT_TARGET = 16.0;")
    .replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 15.0;", "IPHONEOS_DEPLOYMENT_TARGET = 16.0;"),
);

// 6a. App entitlements (generation leaves the file empty).
copyFileSync(
  join(tauriDir, "ios", "app.entitlements"),
  join(apple, "engram-store-desktop_iOS", "engram-store-desktop_iOS.entitlements"),
);
console.log("ios project: app entitlements applied");

// 6b. Brand icons over the placeholder set.
const source = join(tauriDir, "icons", "ios");
const catalog = join(apple, "Assets.xcassets", "AppIcon.appiconset");
const catalogNames = new Set(readdirSync(catalog));
let stamped = 0;
for (const name of readdirSync(source)) {
  if (!name.endsWith(".png") || !catalogNames.has(name)) continue;
  const target = join(catalog, name);
  copyFileSync(join(source, name), target);
  const size = Number(sips("-g", "pixelWidth", target).toString().match(/pixelWidth: (\d+)/)?.[1]);
  if (!size) continue;
  const zoomed = Math.round(size * 1.16);
  sips("-z", String(zoomed), String(zoomed), target);
  sips("-c", String(size), String(size), target);
  const flat = `${target}.jpg`;
  sips("-s", "format", "jpeg", "-s", "formatOptions", "best", target, "--out", flat);
  sips("-s", "format", "png", flat, "--out", target);
  unlinkSync(flat);
  stamped++;
}
console.log(`ios project: stamped ${stamped} brand icons over the placeholder set`);

// 6c. Privacy usage strings and capability flags into the generated
// Info.plist. Strings and booleans both: the document-browser keys that
// put Documents/Downloads in the Files app are <true/>.
const infoPlist = join(apple, "engram-store-desktop_iOS", "Info.plist");
const wanted = readFileSync(join(tauriDir, "Info.ios.plist"), "utf8");
let info = readFileSync(infoPlist, "utf8");
let added = 0;
for (const match of wanted.matchAll(
  /(<key>\w+<\/key>)\s*(<string>[^<]*<\/string>|<true\/>|<false\/>)/g,
)) {
  const [, key, value] = match;
  if (info.includes(key)) continue;
  info = info.replace("</dict>\n</plist>", `\t${key}\n\t${value}\n</dict>\n</plist>`);
  added++;
}
if (added) {
  writeFileSync(infoPlist, info);
}
console.log(`ios project: ${added ? `added ${added} Info.plist entries` : "Info.plist entries already present"}`);

// 7. Loud verification: every expected target, present in the pbxproj.
const finalProject = readFileSync(project, "utf8");
for (const target of ["engram-store-desktop_iOS", "EngramShare", "EngramFiles"]) {
  if (!finalProject.includes(target)) {
    console.error(`ios project: target ${target} MISSING from the generated project`);
    process.exit(1);
  }
}
if (!existsSync(join(tauriDir, "ios", "EngramCore.xcframework"))) {
  console.log("ios project: note, EngramCore.xcframework not built yet (node scripts/apple-core-build.mjs)");
}
console.log("ios project: all targets verified present");
