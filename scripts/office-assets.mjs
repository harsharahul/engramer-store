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
 *   node scripts/office-assets.mjs --check   verify patch and assert anchors only
 *   node scripts/office-assets.mjs --glue    re-copy our own glue files only
 *   node scripts/office-assets.mjs --clean   remove the derived tree
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
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
 * Served alongside the assets so every deployment carries the upstream
 * license notice; the upstream archives ship no license file of their own.
 */
const NOTICE = `These editor assets derive from ONLYOFFICE Docs (sdkjs, web-apps) and the
x2t document converter, both (c) Ascensio System SIA and licensed under the
GNU AGPL v3.0 (gnu.org/licenses/agpl-3.0.html). They are obtained as prebuilt
releases from github.com/cryptpad/onlyoffice-editor and
github.com/cryptpad/onlyoffice-x2t-wasm at the pinned tags recorded in
scripts/office-assets.mjs, pruned to the Word and Excel engines, and modified
by the patch set recorded in the same script. Complete corresponding source:
the upstream repositories above plus github.com/harsharahul/engramer-store
for the patches and integration glue.
`;

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
 * The vendor patch set: two changes, both to the editor's own page. Each
 * anchor must match exactly once; a moved anchor after an upstream upgrade
 * fails the build loudly instead of silently skipping, which is the only way
 * a patch this small stays trustworthy. The reasoning for each lives in
 * docs/office-editing.md.
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
];

/**
 * Not patched, only asserted: the vendor behaviors the shim compensates
 * for. The engine pastes HTML through an iframe it creates, which cannot
 * work in a sandboxed document because the nested frame lands in its own
 * opaque origin, and the same handler leaks the long-action counter that
 * gates every keystroke when a paste dies early. The shim takes the HTML
 * paste over instead of patching 19MB engine files (a patch would also
 * force their brotli siblings through a quality-11 recompress on every
 * build). If an anchor stops matching, upstream changed the paste path
 * and the takeover must be re-read; it may have become unnecessary.
 */
const ASSERTS = [
  {
    id: "paste-iframe",
    files: ["sdkjs/word/sdk-all.js", "sdkjs/cell/sdk-all.js"],
    find: 'ifr.setAttribute("sandbox","allow-same-origin")',
  },
  {
    id: "paste-counter-leak",
    files: ["sdkjs/word/sdk-all.js", "sdkjs/cell/sdk-all.js"],
    find: "if(!_clipboard||!_clipboard.getData)return false;",
  },
  {
    id: "copy-new-path",
    files: ["sdkjs/word/sdk-all.js", "sdkjs/cell/sdk-all.js"],
    find: "isUseNewCopy:function(){if(navigator.clipboard){",
  },
  {
    id: "copy-event-path",
    files: ["sdkjs/word/sdk-all.js", "sdkjs/cell/sdk-all.js"],
    find: "document.oncopy=function(e){if(g_clipboardBase.isUseNewCopy()){",
  },
];

/** Verifies the ASSERTS anchors; never rewrites a byte. */
async function assertVendor(base) {
  for (const assert of ASSERTS) {
    for (const file of assert.files) {
      const source = await readFile(join(base, file), "utf8");
      const hits = source.split(assert.find).length - 1;
      if (hits !== 1) {
        throw new Error(
          `assert "${assert.id}" expected exactly 1 anchor in ${file}, found ${hits}. ` +
            `The upstream paste path changed; re-read the shim's paste takeover before shipping.`,
        );
      }
    }
    console.log(`asserted  ${assert.id}`);
  }
}

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
        // An applied patch must be applied exactly once: a second copy means
        // the tree was patched twice and the editor would load two shims.
        if (already !== 1) {
          throw new Error(`patch "${patch.id}" appears ${already} times in ${file}`);
        }
        continue;
      }
      const hits = source.split(patch.find).length - 1;
      if (hits !== 1) {
        throw new Error(
          `patch "${patch.id}" expected exactly 1 anchor in ${file}, found ${hits}. ` +
            `The upstream build changed; re-validate before shipping.`,
        );
      }
      if (checkOnly) {
        continue;
      }
      await writeFile(path, source.replace(patch.find, patch.replace));
      // The release ships a pre-compressed sibling for most files. Patching
      // the original leaves that sibling stale, and a server that prefers it
      // would serve the unpatched bytes: the editor would load without the
      // shim and die on the first cross-origin parent read. Recompress.
      const sibling = `${path}.br`;
      if (existsSync(sibling)) {
        await writeFile(sibling, brotliCompressSync(await readFile(path)));
      }
    }
    console.log(`${checkOnly ? "verified " : "patched  "} ${patch.id}`);
  }
}

/**
 * The release pre-compresses its JavaScript but ships the converter as a
 * bare 57MB WebAssembly binary. The editor frame is an opaque origin and so
 * has no usable HTTP cache, which means every document open re-fetches it;
 * compressing it here is the difference between ~55MB and ~10MB per open.
 */
async function compressLargeAssets(base) {
  const MIN_BYTES = 1024 * 1024;
  let written = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.name.endsWith(".br") || existsSync(`${path}.br`)) {
        continue;
      }
      const info = await stat(path);
      if (info.size < MIN_BYTES) {
        continue;
      }
      const bytes = await readFile(path);
      // Quality 9 keeps a 57MB binary under a minute while giving up almost
      // nothing against the default; this runs on every image build.
      await writeFile(
        `${path}.br`,
        brotliCompressSync(bytes, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 9,
            [constants.BROTLI_PARAM_SIZE_HINT]: info.size,
          },
        }),
      );
      written++;
      const after = (await stat(`${path}.br`)).size;
      console.log(
        `compressed ${relative(base, path)} ${(info.size / 1048576).toFixed(1)}MB -> ` +
          `${(after / 1048576).toFixed(1)}MB`,
      );
    }
  };
  await walk(base);
  return written;
}

/**
 * Guards against the failure the patch step is designed to prevent: a
 * pre-compressed sibling whose contents no longer match the file it shadows.
 * Any mismatch means a client negotiating compression gets different code
 * from one that does not.
 */
async function verifyCompressedSiblings(base) {
  const mismatched = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith(".br")) {
        continue;
      }
      const original = path.slice(0, -3);
      if (!existsSync(original)) {
        continue; // compressed-only assets are legitimate
      }
      const decoded = brotliDecompressSync(await readFile(path));
      if (!decoded.equals(await readFile(original))) {
        mismatched.push(relative(base, original));
      }
    }
  };
  await walk(base);
  if (mismatched.length > 0) {
    throw new Error(
      `compressed siblings disagree with their sources:\n  ${mismatched.join("\n  ")}`,
    );
  }
  console.log("verified  compressed siblings match their sources");
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
    await assertVendor(outDir);
    await verifyCompressedSiblings(outDir);
    return;
  }
  if (args.has("--glue")) {
    // Re-copies only our own glue (the shim and manifests) into the derived
    // tree, for iterating on the shim without a full re-vendor.
    for (const name of await readdir(join(root, "apps/web/office"))) {
      await execFile("cp", [join(root, "apps/web/office", name), outDir]);
    }
    console.log("copied glue into", relative(root, outDir));
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

  await writeFile(join(outDir, "NOTICE.txt"), NOTICE);

  // Our own glue (the sandbox shim and the editor's asset manifests) is
  // tracked in the repo; the derived tree only ever holds copies, so editing
  // it there is never how any of it changes.
  for (const name of await readdir(join(root, "apps/web/office"))) {
    await execFile("cp", [join(root, "apps/web/office", name), outDir]);
  }

  await applyPatches(outDir, false);
  await assertVendor(outDir);
  await compressLargeAssets(outDir);
  await verifyCompressedSiblings(outDir);
  await rm(staging, { recursive: true, force: true });
  console.log(`office assets ready: ${await measure(outDir)} MB in ${relative(root, outDir)}`);
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
