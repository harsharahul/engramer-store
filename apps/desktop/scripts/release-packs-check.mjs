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
 * The manifest defaults to apps/web/dist-local/core/packs.json. A local
 * host (http://127.0.0.1:<port>/) stands in for the release page in tests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Downloads one archive and reports what arrived. */
export async function fetchDigest(url, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    return { ok: false, status: response.status, bytes: 0, sha256: null };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { ok: true, status: response.status, bytes, sha256: hash.digest("hex") };
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
      ? `HTTP ${got.status}`
      : got.bytes !== pack.archiveBytes
        ? `${got.bytes} bytes, the manifest says ${pack.archiveBytes}`
        : got.sha256 !== pack.archiveSha256
          ? "the digest differs"
          : "";
    results.push({ name, url, match, reason });
  }
  return results;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const manifestPath = arg("--manifest", join(here, "..", "..", "web", "dist-local", "core", "packs.json"));
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
