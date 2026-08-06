#!/usr/bin/env node
/**
 * Repairs the generated iOS Xcode project after `tauri ios init`.
 *
 * Generation reintroduces three defects, so ios:init runs this every
 * time; each step is safe to repeat:
 *
 *  - The Rust static library is listed in the Resources build phase as
 *    well as in Frameworks, so archives ship libapp.a inside the app
 *    bundle and App Store validation refuses them: standalone
 *    libraries are not permitted in a bundle. Linking alone is
 *    correct; the resource copy goes.
 *  - The deployment target is generated at 14.0 regardless of
 *    configuration, and App Store Connect warns below 15.0 today and
 *    refuses it from spring 2027.
 *  - The app icon set ships the framework's placeholder art. The
 *    committed brand icons in icons/ios replace it, zoomed past their
 *    rounded corners to full bleed (iOS applies its own corner mask)
 *    and flattened, because the App Store icon may not carry an alpha
 *    channel.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, "..", "src-tauri");
const apple = join(tauriDir, "gen", "apple");
const project = join(apple, "engram-store-desktop.xcodeproj", "project.pbxproj");

const sips = (...args) => execFileSync("sips", args, { stdio: ["ignore", "pipe", "ignore"] });

const before = readFileSync(project, "utf8");
const lines = before.split("\n");
const kept = lines.filter((line) => !line.includes("libapp.a in Resources"));
if (kept.length < lines.length) {
  console.log(`ios project: dropped ${lines.length - kept.length} resource-copy references to libapp.a`);
} else {
  console.log("ios project: resource copy of libapp.a already absent");
}
writeFileSync(
  project,
  kept.join("\n").replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 14.0;", "IPHONEOS_DEPLOYMENT_TARGET = 15.0;"),
);

const yml = join(apple, "project.yml");
writeFileSync(yml, readFileSync(yml, "utf8").replace("iOS: 14.0", "iOS: 15.0"));
console.log("ios project: deployment target floored at 15.0");

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
