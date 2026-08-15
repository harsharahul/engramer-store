/**
 * Measures a configured backing store the way this server actually uses
 * it, so budget and geometry settings can come from numbers instead of
 * guesses. Run against any S3 endpoint, sidecar or direct:
 *
 *   ENGRAMER_S3_ENDPOINT=http://127.0.0.1:8333 \
 *   ENGRAMER_S3_BUCKET=blobs \
 *   ENGRAMER_S3_ACCESS_KEY=... ENGRAMER_S3_SECRET_KEY=... \
 *   ENGRAMER_S3_CHECKSUMS=when-required \
 *   pnpm --filter @engramer/server exec tsx bench/backend-bench.ts
 *
 * Reports: multipart upload throughput, whole and ranged download with
 * time to first byte, one media window, and small-object rates serial
 * and concurrent. Every fixture is deleted afterward, and the round trip
 * is verified byte-exact before any number is trusted.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { S3BlobStore } from "../src/s3.js";

const MiB = 1024 * 1024;
const BIG = Number(process.env.BENCH_BIG_BYTES ?? 128 * MiB);
const PART = 8 * MiB;
const SMALL_COUNT = Number(process.env.BENCH_SMALL_COUNT ?? 50);
const SMALL = 64 * 1024;
const WINDOW = 32 * MiB;

function ms(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function line(phase: string, millis: number, bytes = 0, note = ""): void {
  const rate = bytes ? `${(bytes / MiB / (millis / 1000)).toFixed(1)} MiB/s` : "";
  console.log(
    `${phase.padEnd(30)} ${String(Math.round(millis)).padStart(8)} ms ${rate.padStart(12)}  ${note}`,
  );
}

async function drain(stream: Readable): Promise<{ ttfb: number; total: number; bytes: Buffer }> {
  const t0 = process.hrtime.bigint();
  let ttfb = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!ttfb) {
      ttfb = ms(t0);
    }
    chunks.push(chunk as Buffer);
  }
  return { ttfb, total: ms(t0), bytes: Buffer.concat(chunks) };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function main(): Promise<void> {
  const config = loadConfig({ dataDir: process.env.ENGRAMER_DATA_DIR ?? "/tmp/engram-bench-data" });
  if (!config.s3) {
    console.error("configure ENGRAMER_S3_* first; this bench measures S3-protocol backends");
    process.exit(2);
  }
  const store = new S3BlobStore(config.s3);
  await store.init();
  console.log(`bench against ${config.s3.endpoint ?? "aws"} bucket ${config.s3.bucket}\n`);

  const key = `bench-${Date.now()}`;
  const payload = randomBytes(BIG);
  const smallKeys: string[] = [];
  try {
    // Multipart upload in our real shape: fixed-size streamed parts.
    {
      const t0 = process.hrtime.bigint();
      const handle = await store.beginParts(key);
      const receipts: { partNo: number; etag?: string }[] = [];
      for (let offset = 0, partNo = 1; offset < BIG; offset += PART, partNo++) {
        const body = payload.subarray(offset, Math.min(offset + PART, BIG));
        const receipt = await store.putPart(key, handle, partNo, Readable.from(body), body.length);
        receipts.push({ partNo, etag: receipt.etag });
      }
      await store.completeParts(key, handle, receipts);
      line(`upload ${BIG / MiB} MiB`, ms(t0), BIG, `${PART / MiB} MiB parts, serial`);
    }

    // Whole download, verified before any other number is trusted.
    {
      const r = await drain(await store.get(key));
      const verdict = sha(r.bytes) === sha(payload) ? "bytes MATCH" : "bytes DIFFER";
      line(`download ${BIG / MiB} MiB`, r.total, BIG, `ttfb ${Math.round(r.ttfb)} ms, ${verdict}`);
      if (verdict !== "bytes MATCH") {
        throw new Error("round trip corrupted the payload; no other number matters");
      }
    }

    // Ranged reads: the seek path. Twice per offset to show warm behavior.
    for (const pass of [1, 2]) {
      for (const at of [0, Math.floor(BIG / 2), BIG - MiB]) {
        const r = await drain(await store.get(key, { start: at, end: at + MiB - 1 }));
        line(
          `ranged 1 MiB @${Math.round(at / MiB)} MiB, pass ${pass}`,
          r.total,
          MiB,
          `ttfb ${Math.round(r.ttfb)} ms`,
        );
      }
    }

    // One media window, the unit the content tier fetches.
    {
      const r = await drain(await store.get(key, { start: 0, end: Math.min(WINDOW, BIG) - 1 }));
      line("window 32 MiB", r.total, Math.min(WINDOW, BIG), `ttfb ${Math.round(r.ttfb)} ms`);
    }

    // Small objects: request-rate bound, the derived-blob shape.
    {
      const body = randomBytes(SMALL);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < SMALL_COUNT; i++) {
        const k = `${key}-${i}.thumb`;
        smallKeys.push(k);
        await store.put(k, Readable.from(body), SMALL * 2);
      }
      line(
        `put ${SMALL_COUNT} x 64 KiB serial`,
        ms(t0),
        0,
        `${(SMALL_COUNT / (ms(t0) / 1000)).toFixed(1)} objects/s`,
      );

      const t1 = process.hrtime.bigint();
      for (const k of smallKeys) {
        await drain(await store.get(k));
      }
      line(
        `get ${SMALL_COUNT} x 64 KiB serial`,
        ms(t1),
        0,
        `${(SMALL_COUNT / (ms(t1) / 1000)).toFixed(1)} objects/s`,
      );

      const t2 = process.hrtime.bigint();
      await Promise.all(smallKeys.map(async (k) => drain(await store.get(k))));
      line(
        `get ${SMALL_COUNT} x 64 KiB parallel`,
        ms(t2),
        0,
        `${(SMALL_COUNT / (ms(t2) / 1000)).toFixed(1)} objects/s`,
      );
    }
  } finally {
    console.log("\ncleaning up fixtures");
    await store.remove(key).catch(() => {});
    for (const k of smallKeys) {
      await store.remove(k).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
