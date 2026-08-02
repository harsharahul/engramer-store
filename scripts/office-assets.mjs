#!/usr/bin/env node
/**
 * Fetches, verifies, prunes and patches the OnlyOffice editor assets that the
 * Word and Excel editors run on.
 *
 * The assets are ~550MB of upstream release archives that prune to a fraction
 * of that, so they are neither committed nor published: this script fetches
 * pinned releases by tag, checks them against recorded digests, keeps only the
 * parts two editors actually load, and applies the small patch set that lets
 * the editor run inside a sandboxed frame. Everything it produces is derived,
 * reproducible, and gitignored.
 *
 * Usage:
 *   node scripts/office-assets.mjs           fetch, verify, prune, patch
 *   node scripts/office-assets.mjs --check   verify patch anchors only
 *   node scripts/office-assets.mjs --clean   remove the derived tree
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".office-cache");
const outDir = join(root, "apps/web/public/office");

/**
 * Pinned upstream releases. The digests are of the exact archives the sandbox
 * integration was validated against; a mismatch means the tag moved under us
 * and the build must stop rather than ship unreviewed editor code.
 */
const RELEASES = {
  editor: {
    url: "https://github.com/cryptpad/onlyoffice-editor/releases/download/v9.2.0.119%2B5/onlyoffice-editor.zip",
    file: "onlyoffice-editor-v9.2.0.119+5.zip",
    sha256: "3f4987af072ba18ad2543c82ada6e41e33a6f38b1ec5930f79b66d1afb7e0715",
  },
  x2t: {
    url: "https://github.com/cryptpad/onlyoffice-x2t-wasm/releases/download/v7.3%2B1/x2t.zip",
    file: "x2t-v7.3+1.zip",
    sha256: "86b6f1ac8f110b5a416ad199efa4c08957d46d989defe791b9793a966cfb3a04",
  },
};

/**
 * Only these subtrees are served. The upstream build carries PowerPoint, PDF
 * and Visio engines, per-locale help (the single largest directory), spelling
 * dictionaries and IE shims, none of which a Word or Excel editor loads.
 */
const KEEP = [
  "sdkjs/common",
  "sdkjs/word",
  "sdkjs/cell",
  "web-apps/vendor",
  "web-apps/apps/common",
  "web-apps/apps/api",
  "web-apps/apps/documenteditor",
  "web-apps/apps/spreadsheeteditor",
  "fonts",
];

/** Dropped inside the kept subtrees: dead weight for a browser editor. */
const DROP_DIRS = new Set(["ie", "help", "embed", "forms", "mobile"]);
const DROP_EXT = new Set([".map"]);
/**
 * The editors ship 45 translations each. The app is English-only today, so the
 * rest are dropped; adding a language means adding it here, not re-vendoring.
 */
const KEEP_LOCALES = new Set(["en.json"]);
const LOCALE_DIRS = [
  "web-apps/apps/documenteditor/main/locale",
  "web-apps/apps/spreadsheeteditor/main/locale",
];

/**
 * The vendor patch set. Each anchor must match exactly once; a moved anchor
 * after an upstream upgrade fails the build loudly instead of silently
 * skipping, which is the only way a patch this small stays trustworthy.
 * The reasoning for each lives in docs/office-editing.md.
 */
const PATCHES = [
  {
    id: "shim",
    files: [
      "web-apps/apps/documenteditor/main/index.html",
      "web-apps/apps/spreadsheeteditor/main/index.html",
    ],
    find: "<head>",
    replace: '<head>\n<script src="/office/engram-sandbox-shim.js"></script>',
  },
  {
    id: "service-worker-guard",
    files: [
      "web-apps/apps/documenteditor/main/index.html",
      "web-apps/apps/spreadsheeteditor/main/index.html",
    ],
    find: '"serviceWorker"in navigator&&',
    replace: "function(){try{return!!navigator.serviceWorker}catch(e){return false}}()&&",
  },
  {
    id: "parent-origin",
    files: ["web-apps/apps/api/documents/api-orig.js"],
    find: "_config.parentOrigin = window.location.origin;",
    replace: "_config.parentOrigin = window.origin;",
  },
  {
    id: "frame-origin",
    files: ["web-apps/apps/api/documents/api-orig.js"],
    find: "this.frameOrigin = pathArray[0] + '//' + pathArray[2];",
    replace:
      "this.frameOrigin = window.origin === 'null' ? 'null' : pathArray[0] + '//' + pathArray[2];",
  },
];

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function download(release) {
  const target = join(cacheDir, release.file);
  if (existsSync(target) && (await sha256(target)) === release.sha256) {
    console.log(`cached   ${release.file}`);
    return target;
  }
  console.log(`fetching ${release.file}`);
  const response = await fetch(release.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${release.url}`);
  }
  await mkdir(cacheDir, { recursive: true });
  await pipeline(response.body, createWriteStream(target));
  const digest = await sha256(target);
  if (digest !== release.sha256) {
    await rm(target, { force: true });
    throw new Error(
      `digest mismatch for ${release.file}\n  expected ${release.sha256}\n  actual   ${digest}`,
    );
  }
  return target;
}

/** Recursively removes the subtrees and file kinds no editor loads. */
async function prune(dir) {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DROP_DIRS.has(entry.name)) {
        await rm(path, { recursive: true, force: true });
        removed++;
        continue;
      }
      removed += await prune(path);
      continue;
    }
    if ([...DROP_EXT].some((ext) => entry.name.endsWith(ext))) {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}

async function applyPatches(base, checkOnly) {
  for (const patch of PATCHES) {
    for (const file of patch.files) {
      const path = join(base, file);
      const source = await readFile(path, "utf8");
      const already = source.split(patch.replace).length - 1;
      if (already > 0) {
        continue; // idempotent: an applied patch is not an error
      }
      const hits = source.split(patch.find).length - 1;
      if (hits !== 1) {
        throw new Error(
          `patch "${patch.id}" expected exactly 1 anchor in ${file}, found ${hits}. ` +
            `The upstream build changed; re-validate before shipping.`,
        );
      }
      if (!checkOnly) {
        await writeFile(path, source.replace(patch.find, patch.replace));
      }
    }
    console.log(`${checkOnly ? "anchor ok" : "patched  "} ${patch.id}`);
  }
}

async function measure(dir) {
  const { stdout } = await execFile("du", ["-sk", dir]);
  return Math.round(Number(stdout.split("\t")[0]) / 1024);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--clean")) {
    await rm(outDir, { recursive: true, force: true });
    console.log("removed", relative(root, outDir));
    return;
  }
  if (args.has("--check")) {
    await applyPatches(outDir, true);
    return;
  }

  await mkdir(outDir, { recursive: true });
  const editorZip = await download(RELEASES.editor);
  const x2tZip = await download(RELEASES.x2t);

  const staging = join(cacheDir, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  console.log("unpacking editor release");
  await execFile("unzip", ["-q", editorZip, "-d", staging], { maxBuffer: 1 << 28 });

  for (const keep of KEEP) {
    const from = join(staging, keep);
    if (!existsSync(from)) {
      throw new Error(`upstream layout changed: ${keep} missing from the release`);
    }
    const to = join(outDir, keep);
    await mkdir(dirname(to), { recursive: true });
    await rm(to, { recursive: true, force: true });
    await execFile("cp", ["-R", from, to]);
  }
  let dropped = await prune(outDir);
  for (const dir of LOCALE_DIRS) {
    const path = join(outDir, dir);
    if (!existsSync(path)) {
      continue;
    }
    for (const name of await readdir(path)) {
      if (!KEEP_LOCALES.has(name.replace(/\.br$/, ""))) {
        await rm(join(path, name), { force: true });
        dropped++;
      }
    }
  }
  console.log(`pruned ${dropped} paths`);

  console.log("unpacking x2t");
  await execFile("unzip", ["-qo", x2tZip, "-d", join(outDir, "x2t")], { maxBuffer: 1 << 28 });

  // Our own shim is tracked in the repo; the derived tree only ever holds a
  // copy, so editing it here is never how it changes.
  await execFile("cp", [join(root, "apps/web/office/engram-sandbox-shim.js"), outDir]);

  await applyPatches(outDir, false);
  await rm(staging, { recursive: true, force: true });
  console.log(`office assets ready: ${await measure(outDir)} MB in ${relative(root, outDir)}`);
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
