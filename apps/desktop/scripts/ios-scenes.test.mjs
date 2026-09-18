// UIKit built with the iOS 27 SDK refuses to launch an app that has not
// adopted the scene life cycle. These checks keep the two halves of that
// adoption together: the plist manifest that turns scene mode on, and the
// capability that lets the extra iPad windows it allows reach the shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, "..", "src-tauri");

// The plist is XML; the checks run on Linux too, so read the manifest's
// dictionary from the text rather than through a macOS tool.
function dictAfterKey(xml, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<dict>([\\s\\S]*?)</dict>`).exec(xml);
  return match ? match[1] : null;
}

test("the iOS plist declares a scene manifest in the windowing layer's scene mode", () => {
  const xml = readFileSync(join(tauriDir, "Info.ios.plist"), "utf8");
  const manifest = dictAfterKey(xml, "UIApplicationSceneManifest");
  assert.ok(manifest, "UIApplicationSceneManifest missing");
  assert.match(manifest, /<key>UIApplicationSupportsMultipleScenes<\/key>\s*<true\/>/);
  assert.match(manifest, /<key>UISceneConfigurations<\/key>\s*<dict\/>/);
});

test("windows opened for extra scenes are covered by the capability", () => {
  const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities", "default.json"), "utf8"));
  assert.ok(capability.windows.includes("main"), "main window missing");
  assert.ok(capability.windows.includes("main-*"), "scene windows main-* missing");
});
