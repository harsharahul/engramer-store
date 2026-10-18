import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import { checkPacks } from "./release-packs-check.mjs";

/** A release host with the archives it is given; others answer 404. */
async function host(files) {
  const server = createServer((request, response) => {
    const body = files[request.url ?? ""];
    if (!body) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/gzip" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v0.1.0/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function manifestFor(archives) {
  const packs = {};
  for (const [name, bytes] of Object.entries(archives)) {
    packs[name] = {
      archive: `engram-pack-${name}-0.1.0.tar.gz`,
      archiveBytes: bytes.length,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return { schema: 1, version: "0.1.0", baseUrl: "https://example.invalid/v0.1.0", packs };
}

test("every archive on the host, byte for byte, is a match", async () => {
  const office = Buffer.from("office-archive-bytes");
  const intelligence = Buffer.from("intelligence-archive-bytes");
  const manifest = manifestFor({ office, intelligence });
  const release = await host({
    "/v0.1.0/engram-pack-office-0.1.0.tar.gz": office,
    "/v0.1.0/engram-pack-intelligence-0.1.0.tar.gz": intelligence,
  });
  try {
    const results = await checkPacks(manifest, { baseUrl: release.baseUrl });
    assert.deepEqual(
      results.map((r) => [r.name, r.match, r.reason]),
      [
        ["office", true, ""],
        ["intelligence", true, ""],
      ],
    );
  } finally {
    await release.close();
  }
});

test("a missing archive, a short one and a changed one are each a mismatch with the reason", async () => {
  const office = Buffer.from("office-archive-bytes");
  const intelligence = Buffer.from("intelligence-archive-bytes");
  const manifest = manifestFor({ office, intelligence, extra: Buffer.from("extra") });
  const release = await host({
    // The office archive is one byte short; the intelligence one has the
    // right length but other bytes; the extra pack is not there at all.
    "/v0.1.0/engram-pack-office-0.1.0.tar.gz": office.subarray(0, office.length - 1),
    "/v0.1.0/engram-pack-intelligence-0.1.0.tar.gz": Buffer.from("INTELLIGENCE-ARCHIVE-BYTES"),
  });
  try {
    const results = await checkPacks(manifest, { baseUrl: release.baseUrl });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName.office.match, false);
    assert.match(byName.office.reason, /19 bytes, the manifest says 20/);
    assert.equal(byName.intelligence.match, false);
    assert.equal(byName.intelligence.reason, "the digest differs");
    assert.equal(byName.extra.match, false);
    assert.equal(byName.extra.reason, "HTTP 404");
  } finally {
    await release.close();
  }
});

test("a host that cannot be reached is a mismatch with the reason, and the packs after it are still checked", async () => {
  const office = Buffer.from("office-archive-bytes");
  const intelligence = Buffer.from("intelligence-archive-bytes");
  const manifest = manifestFor({ office, intelligence });
  const release = await host({ "/v0.1.0/engram-pack-intelligence-0.1.0.tar.gz": intelligence });
  // The first download fails the way undici reports a refused connection;
  // the second reaches the host.
  const fetchImpl = (url) =>
    url.includes("office")
      ? Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }))
      : fetch(url);
  try {
    const results = await checkPacks(manifest, { baseUrl: release.baseUrl, fetchImpl });
    assert.deepEqual(
      results.map((r) => [r.name, r.match, r.reason]),
      [
        ["office", false, "network error: fetch failed: connect ECONNREFUSED"],
        ["intelligence", true, ""],
      ],
    );
  } finally {
    await release.close();
  }
});
