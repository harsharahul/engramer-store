import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { byteLimiter, type BlobStore, type PartReceipt } from "../src/blobs.js";
import { loadConfig } from "../src/config.js";
import { RoutedBlobStore } from "../src/routed.js";

/** In-memory backend that throws the S3-shaped not-found error. */
class FakeStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  gets = 0;
  puts = 0;

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    this.puts++;
    const limiter = byteLimiter(maxBytes);
    const chunks: Buffer[] = [];
    for await (const chunk of source.pipe(limiter.transform)) {
      chunks.push(chunk as Buffer);
    }
    this.blobs.set(key, Buffer.concat(chunks));
    return limiter.written();
  }

  async get(key: string): Promise<Readable> {
    this.gets++;
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
    }
    return Readable.from(bytes);
  }

  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  readonly parts = new Map<string, Buffer>();

  async beginParts(_key: string): Promise<string> {
    return "fake-handle";
  }

  async putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    const limiter = byteLimiter(length);
    const chunks: Buffer[] = [];
    for await (const chunk of source.pipe(limiter.transform)) {
      chunks.push(chunk as Buffer);
    }
    this.parts.set(`${key}:${handle}:${partNo}`, Buffer.concat(chunks));
    return { bytes: limiter.written() };
  }

  async completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
    this.blobs.set(
      key,
      Buffer.concat(ordered.map((p) => this.parts.get(`${key}:${handle}:${p.partNo}`)!)),
    );
    for (const p of ordered) {
      this.parts.delete(`${key}:${handle}:${p.partNo}`);
    }
  }

  async abortParts(key: string, handle: string): Promise<void> {
    for (const k of [...this.parts.keys()]) {
      if (k.startsWith(`${key}:${handle}:`)) {
        this.parts.delete(k);
      }
    }
  }
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const put = (store: BlobStore, key: string, bytes: Buffer) =>
  store.put(key, Readable.from(bytes), 1024 * 1024);

describe("routed blob store", () => {
  it("sends content and versions to primary, derived blobs to the derived backend", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived);

    await put(routed, "file-1", Buffer.from("content"));
    await put(routed, "file-1.g2", Buffer.from("version"));
    await put(routed, "file-1.thumb", Buffer.from("thumb"));
    await put(routed, "file-1.idx", Buffer.from("index"));

    expect([...primary.blobs.keys()].sort()).toEqual(["file-1", "file-1.g2"]);
    expect([...derived.blobs.keys()].sort()).toEqual(["file-1.idx", "file-1.thumb"]);

    expect(await drain(await routed.get("file-1"))).toEqual(Buffer.from("content"));
    expect(await drain(await routed.get("file-1.thumb"))).toEqual(Buffer.from("thumb"));
  });

  it("falls back to primary for pre-split derived blobs and heals the split", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived);
    const legacy = Buffer.from("pre-split thumbnail");
    primary.blobs.set("old.thumb", legacy);

    expect(await drain(await routed.get("old.thumb"))).toEqual(legacy);
    // Healed: the derived backend now owns the blob and serves the next read.
    expect(derived.blobs.get("old.thumb")).toEqual(legacy);
    primary.blobs.delete("old.thumb");
    expect(await drain(await routed.get("old.thumb"))).toEqual(legacy);
  });

  it("propagates a miss when neither backend has the blob", async () => {
    const routed = new RoutedBlobStore(new FakeStore(), new FakeStore());
    await expect(routed.get("gone.thumb")).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(routed.get("gone")).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("does not swallow non-miss errors from the derived backend", async () => {
    const primary = new FakeStore();
    primary.blobs.set("x.thumb", Buffer.from("bytes"));
    const derived = new FakeStore();
    derived.get = async () => {
      throw Object.assign(new Error("access denied"), { name: "AccessDenied" });
    };
    const routed = new RoutedBlobStore(primary, derived);
    await expect(routed.get("x.thumb")).rejects.toThrow("access denied");
  });

  it("removes derived blobs from both backends", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived);
    // A pre-split copy in primary plus a routed copy in derived.
    primary.blobs.set("file-1.thumb", Buffer.from("old"));
    derived.blobs.set("file-1.thumb", Buffer.from("new"));
    primary.blobs.set("file-1", Buffer.from("content"));

    await routed.remove("file-1.thumb");
    expect(primary.blobs.has("file-1.thumb")).toBe(false);
    expect(derived.blobs.has("file-1.thumb")).toBe(false);
    expect(primary.blobs.has("file-1")).toBe(true);

    await routed.remove("file-1");
    expect(primary.blobs.has("file-1")).toBe(false);
  });
});

describe("derived S3 settings", () => {
  const ENV = [
    "ENGRAMER_S3_BUCKET",
    "ENGRAMER_S3_ENDPOINT",
    "ENGRAMER_S3_ACCESS_KEY",
    "ENGRAMER_S3_SECRET_KEY",
    "ENGRAMER_S3_MAX_TPS",
    "ENGRAMER_S3_DERIVED_BUCKET",
    "ENGRAMER_S3_DERIVED_ENDPOINT",
    "ENGRAMER_JWT_SECRET",
  ];

  afterEach(() => {
    for (const name of ENV) {
      delete process.env[name];
    }
  });

  it("inherits connection settings from the primary but never its budget", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ENDPOINT = "http://primary.example";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_S3_MAX_TPS = "20";
    process.env.ENGRAMER_S3_DERIVED_BUCKET = "derived";

    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.s3Derived).not.toBeNull();
      expect(config.s3Derived!.bucket).toBe("derived");
      expect(config.s3Derived!.endpoint).toBe("http://primary.example");
      expect(config.s3Derived!.accessKeyId).toBe("ak");
      // The primary's throttle exists because the primary is rate-limited;
      // the derived store must not inherit it.
      expect(config.s3!.maxTps).toBe(20);
      expect(config.s3Derived!.maxTps).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores a derived bucket when no primary S3 backend is configured", () => {
    process.env.ENGRAMER_S3_DERIVED_BUCKET = "derived";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.s3).toBeNull();
      expect(config.s3Derived).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prefers an explicit jwt secret from the environment over the data-dir file", () => {
    process.env.ENGRAMER_JWT_SECRET = "shared-signing-secret";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      expect(loadConfig({ dataDir }).jwtSecret).toBe("shared-signing-secret");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
