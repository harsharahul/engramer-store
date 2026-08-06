#!/usr/bin/env node
/**
 * Repairs the generated iOS Xcode project after `tauri ios init`.
 *
 * The generator lists the Rust static library in the Resources build
 * phase as well as in Frameworks, so the archive ships libapp.a inside
 * the app bundle and App Store validation refuses it: standalone
 * libraries are not permitted in a bundle. Linking alone is correct;
 * this drops the resource copy. Safe to run any number of times.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(
  here,
  "..",
  "src-tauri",
  "gen",
  "apple",
  "engram-store-desktop.xcodeproj",
  "project.pbxproj",
);

const before = readFileSync(project, "utf8");
const lines = before.split("\n");
const kept = lines.filter((line) => !line.includes("libapp.a in Resources"));
if (kept.length === lines.length) {
  console.log("ios project: resource copy of libapp.a already absent");
} else {
  writeFileSync(project, kept.join("\n"));
  console.log(`ios project: dropped ${lines.length - kept.length} resource-copy references to libapp.a`);
}
