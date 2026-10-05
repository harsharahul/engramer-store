#!/usr/bin/env node
/**
 * Sorts every file of the web build into the core bundle or one of the
 * download packs, for installs that serve the client from the device
 * itself. The core ships inside the app; each pack is downloaded when a
 * feature that needs it is first switched on. A file that matches no rule
 * fails the build, so a new asset directory cannot silently grow the
 * bundled core, and the service worker may precache core files only,
 * because a device without a pack could not install it otherwise.
 *
 *   node scripts/partition.mjs --check dist
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_NAMES = ["office", "intelligence"];

/** Ceiling for the bundled core (measured at 13 MB). */
export const CORE_BUDGET_BYTES = 20 * 1024 * 1024;

const CORE_ROOT_FILES = new Set([
  "index.html",
  "sw.js",
  "registerSW.js",
  "manifest.webmanifest",
  "version.json",
  "x2t-worker.js",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
]);

/** First match wins: the packs claim their paths before the core does. */
const RULES = [
  { name: "office", matches: (path) => path.startsWith("office/") },
  {
    name: "intelligence",
    matches: (path) =>
      /^(models|ort|gliner-ort|ocr)\//.test(path) || /^assets\/ort-wasm[^/]*\.wasm$/.test(path),
  },
  {
    name: "core",
    matches: (path) =>
      CORE_ROOT_FILES.has(path) || /^assets\/[^/]+$/.test(path) || /^(brand|zxing)\//.test(path),
  },
];

/** "core", "office" or "intelligence"; null when no rule matches. */
export function classify(path) {
  for (const rule of RULES) {
    if (rule.matches(path)) {
      return rule.name;
    }
  }
  return null;
}

/** Every file under `dir` as sorted, "/"-separated relative paths. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The paths a built service worker precaches. */
export function precachePaths(swSource) {
  return [...swSource.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1].replace(/^\//, "")).sort();
}

/**
 * Classifies a built dist directory. Throws one error naming every
 * problem: files no rule claims, precache entries outside the core, and a
 * core over budget.
 */
export function checkDist(dist, { coreBudgetBytes = CORE_BUDGET_BYTES } = {}) {
  if (!existsSync(dist)) {
    throw new Error(`partition: 1 problem(s)\n  - ${dist} does not exist; build the web client first`);
  }
  const groups = { core: [], office: [], intelligence: [] };
  const problems = [];
  for (const path of listFiles(dist)) {
    const name = classify(path);
    if (name === null) {
      problems.push(`no pack rule matches ${path}; add it to RULES in scripts/partition.mjs`);
      continue;
    }
    groups[name].push({ path, bytes: statSync(join(dist, path)).size });
  }
  const swPath = join(dist, "sw.js");
  if (existsSync(swPath)) {
    for (const url of precachePaths(readFileSync(swPath, "utf8"))) {
      const name = classify(url);
      if (name !== "core") {
        problems.push(
          `the service worker precaches ${url}, which is in the ${name ?? "unclassified"} pack; ` +
            "a device without that pack could not install the worker",
        );
      }
    }
  }
  const coreBytes = totalBytes(groups.core);
  if (coreBytes > coreBudgetBytes) {
    problems.push(`the core is ${coreBytes} bytes, over the ${coreBudgetBytes}-byte budget`);
  }
  if (problems.length > 0) {
    throw new Error(
      `partition: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return groups;
}

function totalBytes(files) {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

/** One human-readable line per group. */
export function summary(groups) {
  return ["core", ...PACK_NAMES].map((name) => {
    const files = groups[name];
    return `${name}: ${files.length} files, ${(totalBytes(files) / 1048576).toFixed(1)} MB`;
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const at = process.argv.indexOf("--check");
  const dist = at >= 0 ? process.argv[at + 1] : undefined;
  if (!dist) {
    console.error("usage: node scripts/partition.mjs --check <dist>");
    process.exit(2);
  }
  try {
    for (const line of summary(checkDist(resolve(dist)))) {
      console.log(`partition: ${line}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
