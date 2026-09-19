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

test("the vendored windowing layer autoreleases the scene configuration it hands UIKit", () => {
  // tao 0.35.3 freed the configuration on return; UIKit then retained a dead
  // object and every release launch crashed. The workspace patches tao with
  // the fix, so both the patch and the fixed line have to stay in place.
  const workspace = readFileSync(join(here, "..", "..", "..", "Cargo.toml"), "utf8");
  assert.match(workspace, /^tao = \{ path = "apps\/desktop\/vendor\/tao" \}/m);
  const view = readFileSync(join(here, "..", "vendor", "tao", "src", "platform_impl", "ios", "view.rs"), "utf8");
  const fn = /fn configuration_for_connecting_scene_session[\s\S]*?\n  \}\n/.exec(view);
  assert.ok(fn, "configuration_for_connecting_scene_session missing");
  assert.match(fn[0], /Retained::autorelease_return\(config\)/);
  assert.doesNotMatch(fn[0], /Retained::as_ptr\(&config\)/);
});

test("windows opened for extra scenes are covered by the capability", () => {
  const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities", "default.json"), "utf8"));
  assert.ok(capability.windows.includes("main"), "main window missing");
  assert.ok(capability.windows.includes("main-*"), "scene windows main-* missing");
});
