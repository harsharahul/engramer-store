import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3BlobStore } from "../src/s3.js";
import { ShardedKeyStore } from "../src/sharded.js";

/**
 * End-to-end against a real `rclone serve s3`, the bridge that turns any
 * rclone remote into a backing store. Runs whenever an rclone binary is on
 * the path, no credentials or network needed: the remote is a temp
 * directory, which exercises the same gofakes3 server the deployed sidecar
 * runs.
 *
 * This is the suite that pins the compatibility class that corrupts or
 * refuses bytes rather than erroring cleanly: the SDK's default checksum
 * posture rewrites streaming bodies into aws-chunked framing that this
 * server refuses with 411 MissingContentLength, so every store here runs
 * checksums "when-required", exactly as the provider recipes do. Every
 * assertion is byte equality, not mere success.
 */

const rclonePresent = spawnSync("rclone", ["version"], { stdio: "ignore" }).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no port")));
      }
    });
  });
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const sha = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!rclonePresent)("rclone serve s3 backing store", () => {
  let serve: ChildProcess;
  let remoteDir: string;
  let store: S3BlobStore;
  const bucket = "engram-e2e";

  beforeAll(async () => {
    remoteDir = mkdtempSync(join(tmpdir(), "rclone-remote-"));
    const port = await freePort();
    serve = spawn(
      "rclone",
      [
        "serve",
        "s3",
        remoteDir,
        "--addr",
        `127.0.0.1:${port}`,
        "--auth-key",
        "e2ekey,e2esecret",
      ],
      { stdio: "ignore" },
    );
    store = new S3BlobStore({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      bucket,
      accessKeyId: "e2ekey",
      secretAccessKey: "e2esecret",
      forcePathStyle: true,
      checksums: "when-required",
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await store.init();
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }, 20_000);

  afterAll(() => {
    serve?.kill();
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it("round-trips a streamed blob byte-exactly", async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const written = await store.put("whole-blob", Readable.from(bytes), bytes.length * 2);
    expect(written).toBe(bytes.length);
    const back = await drain(await store.get("whole-blob"));
    expect(back.length).toBe(bytes.length);
    expect(sha(back)).toBe(sha(bytes));
    await store.remove("whole-blob");
  });

  it("serves ranged reads byte-exactly", async () => {
    const bytes = randomBytes(1024 * 1024);
    await store.put("ranged-blob", Readable.from(bytes), bytes.length * 2);
    const middle = await drain(await store.get("ranged-blob", { start: 100_000, end: 200_000 }));
    expect(sha(middle)).toBe(sha(bytes.subarray(100_000, 200_001)));
    const tail = await drain(
      await store.get("ranged-blob", { start: bytes.length - 4096, end: bytes.length - 1 }),
    );
    expect(sha(tail)).toBe(sha(bytes.subarray(bytes.length - 4096)));
    await store.remove("ranged-blob");
  });

  it("assembles streaming parts sent out of order, byte-exactly", async () => {
    // The exact shape our upload route produces: concurrent parts landing
    // by number, bodies streamed rather than materialized. This is the
    // case the SDK's default checksum posture breaks with 411.
    const partSize = 5 * 1024 * 1024;
    const parts = [1, 2, 3, 4].map(() => randomBytes(partSize));
    const expected = Buffer.concat(parts);
    const handle = await store.beginParts("parted-blob");
    const receipts: { partNo: number; etag?: string }[] = [];
    for (const partNo of [4, 3, 2, 1]) {
      const receipt = await store.putPart(
        "parted-blob",
        handle,
        partNo,
        Readable.from(parts[partNo - 1]!),
        partSize,
      );
      expect(receipt.bytes).toBe(partSize);
      receipts.push({ partNo, etag: receipt.etag });
    }
    await store.completeParts("parted-blob", handle, receipts);
    const back = await drain(await store.get("parted-blob"));
    expect(back.length).toBe(expected.length);
    expect(sha(back)).toBe(sha(expected));
    await store.remove("parted-blob");
  }, 30_000);

  it("a sharded layout lands keys in nested directories on the remote", async () => {
    const sharded = new ShardedKeyStore(store);
    const bytes = randomBytes(64 * 1024);
    await sharded.put("abcd-e2e-blob.thumb", Readable.from(bytes), bytes.length * 2);
    expect(existsSync(join(remoteDir, bucket, "ab", "cd", "abcd-e2e-blob.thumb"))).toBe(true);
    const back = await drain(await sharded.get("abcd-e2e-blob.thumb"));
    expect(sha(back)).toBe(sha(bytes));
    await sharded.remove("abcd-e2e-blob.thumb");
  });
});
