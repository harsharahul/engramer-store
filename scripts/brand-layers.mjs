#!/usr/bin/env node
/**
 * Renders the depth layers of the Liquid Glass app icon from the brand
 * artwork. The SVG file is placed in a page byte for byte; page CSS
 * around it chooses which of its own shapes are visible, so the artwork
 * itself is never edited. Output: transparent 1024 px PNGs in
 * brand/glass/layers, one per layer, which scripts/brand-glass.mjs
 * composes into Icon Composer documents.
 *
 *   PLAYWRIGHT_CORE=/path/to/playwright-core \
 *   PLAYWRIGHT_CHROME=/path/to/chrome node scripts/brand-layers.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "brand", "icon-ocean-solid.svg");
const out = join(root, "brand", "glass", "layers");

const LAYERS = {
  // The shield body and its folded corner.
  shield: 'svg > rect[width="512"], svg rect:not([width="512"]) { display: none; }',
  // The seven text bars.
  lines: 'svg path, svg > rect[width="512"] { display: none; }',
};

if (!process.env.PLAYWRIGHT_CORE) {
  console.error("brand-layers: set PLAYWRIGHT_CORE to a playwright-core install");
  process.exit(1);
}
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const svg = readFileSync(source, "utf8");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROME });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
for (const [name, css] of Object.entries(LAYERS)) {
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent}` +
      `svg{width:1024px;height:1024px;display:block}${css}</style></head><body>${svg}</body></html>`,
  );
  await page.locator("svg").screenshot({ path: join(out, `${name}.png`), omitBackground: true });
  console.log(`brand-layers: ${name}.png`);
}
await browser.close();
console.log(`brand-layers: from ${source} sha256 ${createHash("sha256").update(svg).digest("hex")}`);
