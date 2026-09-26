#!/usr/bin/env node
/**
 * Checks the Mac window chrome of a built app: launches the binary with
 * ENGRAM_WINDOW_CHROME_LOG set, reads where the vendored tao reports the
 * traffic lights landed, and compares that with `trafficLightPosition` in
 * tauri.conf.json. The report line is written when the inset is applied,
 * which happens as the window becomes key, so a few seconds suffice.
 *
 * Usage: node scripts/mac-chrome-check.mjs <path to .app> [seconds]
 *
 * The lights are AppKit views; no screenshot or accessibility permission is
 * needed, and the check runs on the same binary that ships.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [appPath, secondsArg] = process.argv.slice(2);
if (!appPath) {
  console.error("usage: mac-chrome-check.mjs <path to .app> [seconds]");
  process.exit(2);
}
const seconds = Number(secondsArg ?? 6);

const config = JSON.parse(readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"));
const window = config.app?.windows?.[0] ?? {};
const expected = window.trafficLightPosition;
if (!expected) {
  console.log("mac-chrome-check: no trafficLightPosition configured; nothing to check");
  process.exit(0);
}

const binary = join(appPath, "Contents", "MacOS", config.mainBinaryName ?? "engram-store-desktop");
const child = spawn(binary, [], {
  env: { ...process.env, ENGRAM_WINDOW_CHROME_LOG: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});

let report = null;
child.stderr.on("data", (chunk) => {
  const match = /window-chrome: close-light top-left=\(([\d.]+),([\d.]+)\) size=([\d.]+)/.exec(String(chunk));
  if (match) {
    report = { x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) };
  }
});

setTimeout(() => {
  child.kill();
  if (!report) {
    console.error(`mac-chrome-check: the app reported no traffic light position within ${seconds}s`);
    process.exit(1);
  }
  const ok = Math.abs(report.x - expected.x) < 0.5 && Math.abs(report.y - expected.y) < 0.5;
  const centre = report.y + report.size / 2;
  console.log(
    `mac-chrome-check: close light top-left (${report.x}, ${report.y}), centre line ${centre}pt; expected (${expected.x}, ${expected.y})`,
  );
  process.exit(ok ? 0 : 1);
}, seconds * 1000);
