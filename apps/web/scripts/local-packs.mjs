#!/usr/bin/env node
/**
 * Builds what an on-device install needs from a finished web build: the
 * core bundle (copied as is), one gzipped tar per download pack, and
 * packs.json, the manifest the app bundles with the core. The manifest
 * names each pack's archive with its size and sha256, and every file in
 * it with its path, size and sha256, so the app can verify each file
 * before it serves it. The same files, file modes and Node version give
 * the same archive bytes. Only the core/ and packs/ folders inside the
 * output directory are replaced; nothing else in it is touched.
 *
 *   pnpm --filter @engramer/web local:packs [-- --dist dist --out dist-local]
 *
 * ENGRAM_PACKS_BASE_URL sets where the app downloads the archives from
 * (default: this version's GitHub release).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { checkDist, PACK_NAMES, summary } from "./partition.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RELEASE_BASE = "https://github.com/harsharahul/engramer-store/releases/download";

export function archiveName(pack, version) {
  return `engram-pack-${pack}-${version}.tar.gz`;
}

export function packsBaseUrl(version, env = process.env) {
  const override = (env.ENGRAM_PACKS_BASE_URL ?? "").trim();
  const base = override || `${DEFAULT_RELEASE_BASE}/v${version}`;
  return base.endsWith("/") ? base : `${base}/`;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A gzipped tar of `paths` (relative to `dist`), sorted, with a fixed
 * timestamp and no owner fields, so the same files give the same bytes.
 */
export async function writeArchive(dist, paths, file) {
  mkdirSync(dirname(file), { recursive: true });
  await tar.c(
    {
      file,
      cwd: dist,
      gzip: { level: 6 },
      portable: true,
      mtime: new Date(0),
      noDirRecurse: true,
    },
    [...paths].sort(),
  );
}

/** True when `inner` is `outer` or lies inside it. */
function within(outer, inner) {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function buildLocal({ dist, out, version, env = process.env }) {
  const distDir = resolve(dist);
  const outDir = resolve(out);
  if (within(outDir, distDir) || within(distDir, outDir)) {
    throw new Error(
      `local-packs: the output directory ${outDir} overlaps the build ${distDir}; choose another --out`,
    );
  }
  const groups = checkDist(distDir);
  for (const name of PACK_NAMES) {
    if (groups[name].length === 0) {
      throw new Error(
        `local-packs: the ${name} pack is empty; build the web client with its assets ` +
          "(scripts/office-assets.mjs, apps/web/scripts/fetch-models.mjs) before packaging",
      );
    }
  }
  const versionFile = join(distDir, "version.json");
  const built = existsSync(versionFile) ? JSON.parse(readFileSync(versionFile, "utf8")).version : null;
  if (built !== version) {
    throw new Error(
      `local-packs: the build is version ${built ?? "unknown (no version.json)"}, not ${version}; ` +
        "rebuild the web client before packaging",
    );
  }
  rmSync(join(outDir, "core"), { recursive: true, force: true });
  rmSync(join(outDir, "packs"), { recursive: true, force: true });
  dist = distDir;
  out = outDir;
  const coreDir = join(out, "core");
  for (const { path } of groups.core) {
    mkdirSync(dirname(join(coreDir, path)), { recursive: true });
    cpSync(join(dist, path), join(coreDir, path));
  }
  const manifest = { schema: 1, version, baseUrl: packsBaseUrl(version, env), packs: {} };
  for (const name of PACK_NAMES) {
    const files = groups[name].map(({ path, bytes }) => ({
      path,
      bytes,
      sha256: sha256File(join(dist, path)),
    }));
    const archive = archiveName(name, version);
    const archivePath = join(out, "packs", archive);
    await writeArchive(dist, files.map((f) => f.path), archivePath);
    manifest.packs[name] = {
      archive,
      archiveBytes: statSync(archivePath).size,
      archiveSha256: sha256File(archivePath),
      installedBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      files,
    };
  }
  writeFileSync(join(coreDir, "packs.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { groups, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (flag, fallback) => {
    const at = process.argv.indexOf(flag);
    return at >= 0 ? process.argv[at + 1] : fallback;
  };
  const dist = resolve(arg("--dist", join(here, "..", "dist")));
  const out = resolve(arg("--out", join(here, "..", "dist-local")));
  const version = JSON.parse(readFileSync(join(here, "..", "..", "..", "package.json"), "utf8")).version;
  try {
    const { groups, manifest } = await buildLocal({ dist, out, version });
    for (const line of summary(groups)) {
      console.log(`local-packs: ${line}`);
    }
    for (const [name, pack] of Object.entries(manifest.packs)) {
      console.log(
        `local-packs: ${name} archive ${(pack.archiveBytes / 1048576).toFixed(1)} MB, sha256 ${pack.archiveSha256}`,
      );
    }
    console.log(`local-packs: core and packs.json in ${join(out, "core")}`);
    console.log("local-packs: publish the archives with the release:");
    const archives = PACK_NAMES.map((name) => JSON.stringify(join(out, "packs", archiveName(name, version))));
    console.log(`  gh release upload v${version} ${archives.join(" ")}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
