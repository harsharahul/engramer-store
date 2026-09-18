// UIKit built with the iOS 27 SDK refuses to launch an app that has not
// adopted the scene life cycle. These checks keep the two halves of that
// adoption together: the plist manifest that turns scene mode on, and the
// capability that lets the extra iPad windows it allows reach the shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, "..", "src-tauri");

function plistJson(path) {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
}

test("the iOS plist declares a scene manifest in the windowing layer's scene mode", () => {
  const plist = plistJson(join(tauriDir, "Info.ios.plist"));
  const manifest = plist.UIApplicationSceneManifest;
  assert.ok(manifest, "UIApplicationSceneManifest missing");
  assert.equal(manifest.UIApplicationSupportsMultipleScenes, true);
  assert.deepEqual(manifest.UISceneConfigurations, {});
});

test("windows opened for extra scenes are covered by the capability", () => {
  const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities", "default.json"), "utf8"));
  assert.ok(capability.windows.includes("main"), "main window missing");
  assert.ok(capability.windows.includes("main-*"), "scene windows main-* missing");
});
