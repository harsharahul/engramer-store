#!/usr/bin/env node
/**
 * The release gate for the feature packs: every archive the bundled
 * manifest names must be on the release host, byte for byte. The script
 * downloads each archive from the manifest's base URL (or --base-url),
 * counts the bytes and hashes them as they stream, and compares both with
 * the manifest. It prints MATCH or MISMATCH per pack and exits non-zero
 * on any mismatch, so a release whose packs are missing or stale cannot
 * be called done.
 *
 *   node scripts/release-packs-check.mjs [--manifest <packs.json>] [--base-url <url>]
 *
 * The manifest defaults to the bundled core's packs.json: the directory
 * ENGRAM_LOCAL_CORE names, else apps/web/dist-local/core, the same choice
 * the app builds make. A local host (http://127.0.0.1:<port>/) stands in
 * for the release page in tests.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The core bundle the app carries, as the build scripts resolve it. */
function bundledCore() {
  const named = (process.env.ENGRAM_LOCAL_CORE ?? "").trim().replace(/^~(?=\/)/, homedir());
  return named || join(here, "..", "..", "web", "dist-local", "core");
}

/** Whether this file is the script Node was asked to run, through any path. */
function invokedAs(argv1) {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Downloads one archive and reports what arrived; a failed connection or
 * a stream that breaks off is a result, not a crash, so the packs after it
 * are still checked. */
export async function fetchDigest(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url);
    if (!response.ok || !response.body) {
      return { ok: false, status: response.status, bytes: 0, sha256: null, error: null };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { ok: true, status: response.status, bytes, sha256: hash.digest("hex"), error: null };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    const message = err instanceof Error ? `${err.message}${cause}` : String(err);
    return { ok: false, status: 0, bytes: 0, sha256: null, error: message };
  }
}

/** Checks every pack of a manifest against the host; one line per pack. */
export async function checkPacks(manifest, { baseUrl = manifest.baseUrl, fetchImpl = fetch } = {}) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const results = [];
  for (const [name, pack] of Object.entries(manifest.packs ?? {})) {
    const url = `${base}${pack.archive}`;
    const got = await fetchDigest(url, fetchImpl);
    const match = got.ok && got.bytes === pack.archiveBytes && got.sha256 === pack.archiveSha256;
    const reason = !got.ok
      ? got.error !== null
        ? `network error: ${got.error}`
        : `HTTP ${got.status}`
      : got.bytes !== pack.archiveBytes
        ? `${got.bytes} bytes, the manifest says ${pack.archiveBytes}`
        : got.sha256 !== pack.archiveSha256
          ? "the digest differs"
          : "";
    results.push({ name, url, match, reason });
  }
  return results;
}

if (invokedAs(process.argv[1])) {
  const manifestPath = arg("--manifest", join(bundledCore(), "packs.json"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const results = await checkPacks(manifest, { baseUrl: arg("--base-url", manifest.baseUrl) });
  let failed = false;
  for (const result of results) {
    console.log(`${result.match ? "MATCH" : "MISMATCH"} ${result.name} ${result.url}${result.reason ? ` (${result.reason})` : ""}`);
    failed ||= !result.match;
  }
  if (results.length === 0) {
    console.error("release-packs-check: the manifest names no packs");
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}
