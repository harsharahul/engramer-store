/**
 * Measures what a mailbox costs a fresh device: unlock, sync, search-index
 * warm-up, memory, search speed and storage, for the mail scale spike.
 * Needs the spike hook (window.__engramSpike, `?spike=1`) on the served
 * client and the spike account on the server.
 *
 * Run: node tools/spikes/mail-scale/measure.mjs --base http://127.0.0.1:3182 \
 *        --engine chromium|webkit --label A-20000 [--needle-expect 3]
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WORDS } from "./corpus.mjs";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.CATALOG_PLAYWRIGHT || "playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const BASE = arg("base", "http://127.0.0.1:3182");
const ENGINE = arg("engine", "chromium");
const LABEL = arg("label", "unlabelled");
const NEEDLE_EXPECT = Number(arg("needle-expect", "3"));
const EMAIL = "spike-mail@example.com";
const PASSWORD = "spike lantern velvet harbor";

/** Twenty two-word queries from the corpus words, the same every run. */
function queries() {
  let state = 99;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
  return Array.from({ length: 20 }, () => {
    const a = WORDS[Math.floor(next() * WORDS.length)];
    const b = WORDS[Math.floor(next() * WORDS.length)];
    return `${a} ${b}`;
  });
}

function scriptName(html) {
  return /<script[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
}

async function main() {
  const engine = ENGINE === "webkit" ? webkit : chromium;
  const browser = await engine.launch({
    headless: true,
    executablePath: ENGINE === "webkit" ? process.env.CATALOG_WEBKIT : process.env.CATALOG_CHROMIUM,
    ...(ENGINE === "chromium" ? { args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"] } : {}),
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();

  let phase = "start";
  const counts = { indexRequests: 0, dataRequests: 0, indexPuts: 0, rate429: 0 };
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/files\/[^/]+\/data(\?|$)/.test(url) && request.method() === "GET") counts.dataRequests++;
    if (/\/api\/files\/[^/]+\/index(\?|$)/.test(url)) {
      if (request.method() === "PUT") counts.indexPuts++;
      if (request.method() === "GET" && phase === "warm") counts.indexRequests++;
    }
  });
  page.on("response", (response) => {
    if (response.status() === 429) counts.rate429++;
  });

  const served = await (await fetch(`${BASE}/`)).text();
  const built = readFileSync(path.join(repo, "apps/web/dist/index.html"), "utf8");
  const bundleOk = scriptName(served) !== null && scriptName(served) === scriptName(built);

  await page.goto(`${BASE}/?spike=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 60_000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  const login = page.waitForResponse((r) => r.url().includes("/api/auth/login"), { timeout: 120_000 });
  const submitted = Date.now();
  await page.keyboard.press("Enter");
  await login;
  const loggedIn = Date.now();
  await page.waitForFunction(
    () => window.__engramSpike && window.__engramSpike.store.getState().synced === true,
    null,
    { timeout: 900_000, polling: 50 },
  );
  const synced = Date.now();

  const pre = await page.evaluate(() => {
    const state = window.__engramSpike.store.getState();
    let withText = 0;
    for (const f of state.files.values()) if (f.text !== undefined && !f.inlineText) withText++;
    return { files: state.files.size, warming: state.indexWarm !== null, withText };
  });

  phase = "warm";
  const warmMs = await page.evaluate(async () => {
    const started = performance.now();
    await window.__engramSpike.store.getState().warmSearchIndex();
    return performance.now() - started;
  });
  phase = "after";

  const heapMB = await page.evaluate(() => {
    if (typeof window.gc === "function") window.gc();
    const memory = performance.memory;
    return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : null;
  });

  const search = await page.evaluate((list) => {
    const { store, searchFiles } = window.__engramSpike;
    const state = store.getState();
    const files = [...state.files.values()].filter((f) => !f.trashed);
    const times = [];
    for (const q of list) {
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        searchFiles(files, q, state.folders);
        times.push(performance.now() - started);
      }
    }
    times.sort((a, b) => a - b);
    const at = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
    return { p50: at(0.5), p95: at(0.95), needleHits: searchFiles(files, "zephyrine", state.folders).length };
  }, queries());

  const storageMB = await page.evaluate(async () => {
    const estimate = await navigator.storage.estimate();
    return Math.round((estimate.usage ?? 0) / 1_048_576);
  });
  await browser.close();

  const row = {
    label: LABEL,
    engine: ENGINE,
    files: pre.files,
    unlockMs: loggedIn - submitted,
    syncMs: synced - loggedIn,
    warmMs: Math.round(warmMs),
    ...counts,
    heapMB,
    searchP50Ms: Math.round(search.p50 * 10) / 10,
    searchP95Ms: Math.round(search.p95 * 10) / 10,
    needleHits: search.needleHits,
    storageMB,
    bundleOk,
    prewarmed: pre.warming || pre.withText > 0,
  };
  appendFileSync(path.join(here, "results.jsonl"), JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));

  const failures = [];
  if (row.dataRequests > 0) failures.push(`content downloads during the run: ${row.dataRequests}`);
  if (row.indexPuts > 0) failures.push(`index uploads during the run: ${row.indexPuts}`);
  if (row.needleHits !== NEEDLE_EXPECT) failures.push(`needle hits ${row.needleHits}, expected ${NEEDLE_EXPECT}`);
  if (!row.bundleOk) failures.push("served bundle differs from apps/web/dist");
  if (row.prewarmed) failures.push("the index was already warming before the measured call");
  if (failures.length > 0) {
    console.error("RUN INVALID: " + failures.join("; "));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
