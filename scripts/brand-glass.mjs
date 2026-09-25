#!/usr/bin/env node
/**
 * Builds the Liquid Glass app icon and every image derived from it.
 *
 * The icon has three levels of depth: the accent gradient tile, the glass
 * shield floating above it, and the text bars floating above the shield.
 * The two artwork layers are renders of brand/icon-ocean-solid.svg (see
 * scripts/brand-layers.mjs); this script composes them into one Icon
 * Composer document per accent palette and renders images with Apple's
 * ictool, so every highlight, edge and shadow comes from Apple's renderer.
 *
 * Writes:
 *   brand/glass/<accent>.icon        the Icon Composer document per palette
 *   brand/glass/<accent>.png         a 512 px preview per palette
 *   apps/desktop/src-tauri/icons/AppIcon.icon   the shipping app icon (Ocean)
 *   apps/desktop/src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png, icon.icns
 *   apps/web/public/{icon-192,icon-512,apple-touch-icon}.png
 *   apps/web/public/brand/<accent>.png   the in-app mark per palette
 *
 * Requires Xcode 26 or later (Icon Composer ships ictool). macOS only.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const glass = join(root, "brand", "glass");
const layers = join(glass, "layers");
const tauriIcons = join(root, "apps", "desktop", "src-tauri", "icons");
const webPublic = join(root, "apps", "web", "public");
const ictool =
  "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";

/** Tile gradients: --brand-a to --brand-b of each accent in styles.css. */
const PALETTES = {
  ocean: ["#172554", "#2563eb"],
  aurora: ["#134e4a", "#6d28d9"],
  emerald: ["#064e3b", "#059669"],
  violet: ["#2e1065", "#7c3aed"],
  sunset: ["#4c0519", "#be123c"],
  midnight: ["#0f172a", "#334155"],
};

const SCALE = 1.4;

function srgb(hex) {
  const channel = (i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5);
  return `extended-srgb:${channel(1)},${channel(3)},${channel(5)},1.00000`;
}

/** Groups are listed front to back, as Icon Composer's sidebar shows them. */
function iconJson([from, to]) {
  return {
    fill: { "linear-gradient": [srgb(from), srgb(to)] },
    groups: [
      {
        layers: [
          {
            glass: true,
            "image-name": "lines.png",
            name: "lines",
            position: { scale: SCALE, "translation-in-points": [0, -28] },
          },
        ],
        shadow: { kind: "layer-color", opacity: 0.6 },
        translucency: { enabled: true, value: 0.2 },
        specular: true,
      },
      {
        layers: [
          {
            glass: true,
            "image-name": "shield.png",
            name: "shield",
            position: { scale: SCALE, "translation-in-points": [0, -10] },
          },
        ],
        shadow: { kind: "neutral", opacity: 1 },
        translucency: { enabled: true, value: 0.3 },
        specular: true,
      },
    ],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  };
}

function writeIcon(dir, palette) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "Assets"), { recursive: true });
  for (const name of ["shield.png", "lines.png"]) {
    cpSync(join(layers, name), join(dir, "Assets", name));
  }
  writeFileSync(join(dir, "icon.json"), `${JSON.stringify(iconJson(palette), null, 2)}\n`);
}

function render(icon, out, size, platform = "iOS") {
  execFileSync(
    ictool,
    [icon, "--export-image", "--output-file", out, "--platform", platform, "--rendition",
      "Default", "--width", "1024", "--height", "1024", "--scale", "1"],
    { stdio: "ignore" },
  );
  if (size !== 1024) {
    execFileSync("sips", ["-z", String(size), String(size), out], { stdio: "ignore" });
  }
}

if (!existsSync(ictool)) {
  console.error("brand-glass: Icon Composer's ictool not found; install Xcode 26 or later");
  process.exit(1);
}

mkdirSync(join(webPublic, "brand"), { recursive: true });
for (const [accent, palette] of Object.entries(PALETTES)) {
  const icon = join(glass, `${accent}.icon`);
  writeIcon(icon, palette);
  render(icon, join(glass, `${accent}.png`), 512);
  render(icon, join(webPublic, "brand", `${accent}.png`), 256);
  console.log(`brand-glass: ${accent}`);
}

const appIcon = join(tauriIcons, "AppIcon.icon");
writeIcon(appIcon, PALETTES.ocean);

for (const [name, size] of [["32x32", 32], ["64x64", 64], ["128x128", 128], ["128x128@2x", 256], ["icon", 512]]) {
  render(appIcon, join(tauriIcons, `${name}.png`), size, "macOS");
}
const iconset = join(mkdtempSync(join(tmpdir(), "brand-glass-")), "icon.iconset");
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  render(appIcon, join(iconset, `icon_${size}x${size}.png`), size, "macOS");
  render(appIcon, join(iconset, `icon_${size}x${size}@2x.png`), size * 2, "macOS");
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(tauriIcons, "icon.icns")]);
rmSync(dirname(iconset), { recursive: true, force: true });

render(appIcon, join(webPublic, "icon-512.png"), 512);
render(appIcon, join(webPublic, "icon-192.png"), 192);
render(appIcon, join(webPublic, "apple-touch-icon.png"), 180);
console.log("brand-glass: app icon, desktop icons, web icons written");
