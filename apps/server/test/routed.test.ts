import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  byteLimiter,
  FsBlobStore,
  type BlobRange,
  type BlobStore,
  type PartReceipt,
} from "../src/blobs.js";
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

  async get(key: string, range?: BlobRange): Promise<Readable> {
    this.gets++;
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
    }
    if (!range) {
      return Readable.from(bytes);
    }
    // S3 semantics: an end past the blob clamps to the last byte.
    return Readable.from(bytes.subarray(range.start, Math.min(range.end + 1, bytes.length)));
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

const put = (store: BlobStore, key: string, bytes: Buffer, seekable?: boolean) =>
  store.put(key, Readable.from(bytes), 1024 * 1024, seekable);

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function patterned(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return bytes;
}

describe("routed blob store", () => {
  it("sends content and versions to primary, derived blobs to the derived backend", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived);

    await put(routed, "file-1", Buffer.from("content"), true);
    await put(routed, "file-1.g2", Buffer.from("version"), true);
    await put(routed, "file-1.thumb", Buffer.from("thumb"));
    await put(routed, "file-1.idx", Buffer.from("index"));

    expect([...primary.blobs.keys()].sort()).toEqual(["file-1", "file-1.g2"]);
    // Seekable content puts also leave hot bookend copies on the derived backend.
    await until(() => derived.blobs.has("file-1.bhead") && derived.blobs.has("file-1.g2.bhead"));
    expect([...derived.blobs.keys()].sort()).toEqual([
      "file-1.bhead",
      "file-1.g2.bhead",
      "file-1.idx",
      "file-1.thumb",
    ]);

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

describe("content bookends", () => {
  const GEOMETRY = { headBytes: 8, tailBytes: 16 };
  const SIZE = 40;

  async function seeded(): Promise<{ primary: FakeStore; derived: FakeStore; routed: RoutedBlobStore; blob: Buffer }> {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    await put(routed, "movie", blob, true);
    await until(() => derived.blobs.has("movie.bhead") && derived.blobs.has("movie.btail"));
    return { primary, derived, routed, blob };
  }

  it("a content put leaves head and tail copies on the fast store", async () => {
    const { derived, blob } = await seeded();
    expect(derived.blobs.get("movie.bhead")).toEqual(blob.subarray(0, 8));
    expect(derived.blobs.get("movie.btail")).toEqual(blob.subarray(SIZE - 16));
  });

  it("serves head and tail ranges from the fast store, middles from the slow one", async () => {
    const { primary, routed, blob } = await seeded();
    const before = primary.gets;
    expect(await drain(await routed.get("movie", { start: 2, end: 7 }, SIZE))).toEqual(
      blob.subarray(2, 8),
    );
    expect(await drain(await routed.get("movie", { start: 30, end: 39 }, SIZE))).toEqual(
      blob.subarray(30, 40),
    );
    expect(primary.gets).toBe(before);
    expect(await drain(await routed.get("movie", { start: 8, end: 23 }, SIZE))).toEqual(
      blob.subarray(8, 24),
    );
    expect(primary.gets).toBe(before + 1);
  });

  it("falls back to the slow store for pre-bookend blobs and heals them", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    primary.blobs.set("old-movie", blob);
    expect(await drain(await routed.get("old-movie", { start: 0, end: 7 }, SIZE))).toEqual(
      blob.subarray(0, 8),
    );
    await until(() => derived.blobs.has("old-movie.bhead") && derived.blobs.has("old-movie.btail"));
    expect(derived.blobs.get("old-movie.btail")).toEqual(blob.subarray(SIZE - 16));
  });

  it("without a size hint every ranged read goes to the slow store, untouched", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    primary.blobs.set("plain", blob);
    expect(await drain(await routed.get("plain", { start: 0, end: 7 }))).toEqual(blob.subarray(0, 8));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(derived.blobs.size).toBe(0);
  });

  it("a part upload leaves bookends sized from its parts", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    const handle = await routed.beginParts("parted");
    await routed.putPart("parted", handle, 1, Readable.from(blob.subarray(0, 24)), 24);
    await routed.putPart("parted", handle, 2, Readable.from(blob.subarray(24)), 16);
    await routed.completeParts("parted", handle, [{ partNo: 1 }, { partNo: 2 }], true);
    await until(() => derived.blobs.has("parted.bhead") && derived.blobs.has("parted.btail"));
    expect(derived.blobs.get("parted.bhead")).toEqual(blob.subarray(0, 8));
    expect(derived.blobs.get("parted.btail")).toEqual(blob.subarray(SIZE - 16));
  });

  it("removing a content blob removes its bookends", async () => {
    const { primary, derived, routed } = await seeded();
    await routed.remove("movie");
    expect(primary.blobs.has("movie")).toBe(false);
    expect(derived.blobs.has("movie.bhead")).toBe(false);
    expect(derived.blobs.has("movie.btail")).toBe(false);
  });

  it("a non-seekable content put leaves no bookends", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    await put(routed, "document", patterned(SIZE));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(primary.blobs.has("document")).toBe(true);
    expect(derived.blobs.size).toBe(0);
  });

  it("a non-seekable part upload leaves no bookends", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    const handle = await routed.beginParts("report");
    await routed.putPart("report", handle, 1, Readable.from(blob.subarray(0, 24)), 24);
    await routed.putPart("report", handle, 2, Readable.from(blob.subarray(24)), 16);
    await routed.completeParts("report", handle, [{ partNo: 1 }, { partNo: 2 }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(primary.blobs.has("report")).toBe(true);
    expect(derived.blobs.size).toBe(0);
  });

  it("a legacy blob with no flag anywhere still heals bookends on a ranged read", async () => {
    const primary = new FakeStore();
    const derived = new FakeStore();
    const routed = new RoutedBlobStore(primary, derived, GEOMETRY);
    const blob = patterned(SIZE);
    primary.blobs.set("pre-flag-movie", blob);
    expect(await drain(await routed.get("pre-flag-movie", { start: 0, end: 7 }, SIZE))).toEqual(
      blob.subarray(0, 8),
    );
    await until(
      () => derived.blobs.has("pre-flag-movie.bhead") && derived.blobs.has("pre-flag-movie.btail"),
    );
  });
});

describe("filesystem derived backend", () => {
  const FS_GEOMETRY = { headBytes: 8, tailBytes: 16 };
  const FS_SIZE = 40;

  it("serves, heals, and bookends through a real filesystem derived store", async () => {
    const primary = new FakeStore();
    const dir = mkdtempSync(join(tmpdir(), "derived-fs-"));
    try {
      const derived = new FsBlobStore(dir);
      const routed = new RoutedBlobStore(primary, derived, FS_GEOMETRY);
      await put(routed, "file-9.thumb", Buffer.from("thumbnail"));
      expect(await drain(await routed.get("file-9.thumb"))).toEqual(Buffer.from("thumbnail"));
      // A pre-split derived blob still in primary must heal through the
      // filesystem store's miss, which is what BlobNotFoundError carries.
      primary.blobs.set("file-8.thumb", Buffer.from("old-thumb"));
      expect(await drain(await routed.get("file-8.thumb"))).toEqual(Buffer.from("old-thumb"));
      await until(() => existsSync(join(dir, "file-8.thumb")));
      const blob = patterned(FS_SIZE);
      await put(routed, "movie-9", blob, true);
      await until(
        () => existsSync(join(dir, "movie-9.bhead")) && existsSync(join(dir, "movie-9.btail")),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("derived S3 settings", () => {
  const ENV = [
    "ENGRAMER_S3_BUCKET",
    "ENGRAMER_S3_ENDPOINT",
    "ENGRAMER_S3_ACCESS_KEY",
    "ENGRAMER_S3_SECRET_KEY",
    "ENGRAMER_S3_MAX_TPS",
    "ENGRAMER_S3_CHECKSUMS",
    "ENGRAMER_S3_CREATE_BUCKET",
    "ENGRAMER_S3_KEY_LAYOUT",
    "ENGRAMER_S3_DERIVED_BUCKET",
    "ENGRAMER_S3_DERIVED_ENDPOINT",
    "ENGRAMER_DERIVED_BACKEND",
    "ENGRAMER_DERIVED_DIR",
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

  it("passes the checksum mode and bucket-creation policy through to the store", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_S3_CHECKSUMS = "when-required";
    process.env.ENGRAMER_S3_CREATE_BUCKET = "false";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.s3!.checksums).toBe("when-required");
      expect(config.s3!.createBucket).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps SDK-default checksums and bucket creation when nothing is set", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.s3!.checksums).toBe("when-supported");
      expect(config.s3!.createBucket).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reads the tier geometry knobs, defaulting to the compiled sizes", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const defaults = loadConfig({ dataDir });
      expect(defaults.mediaWindowBytes).toBe(32 * 1024 * 1024);
      expect(defaults.bookendHeadBytes).toBe(32 * 1024 * 1024);
      expect(defaults.bookendTailBytes).toBe(64 * 1024 * 1024);
      process.env.ENGRAMER_MEDIA_WINDOW_BYTES = String(8 * 1024 * 1024);
      process.env.ENGRAMER_BOOKEND_HEAD_BYTES = String(16 * 1024 * 1024);
      process.env.ENGRAMER_BOOKEND_TAIL_BYTES = String(48 * 1024 * 1024);
      const tuned = loadConfig({ dataDir });
      expect(tuned.mediaWindowBytes).toBe(8 * 1024 * 1024);
      expect(tuned.bookendHeadBytes).toBe(16 * 1024 * 1024);
      expect(tuned.bookendTailBytes).toBe(48 * 1024 * 1024);
    } finally {
      delete process.env.ENGRAMER_MEDIA_WINDOW_BYTES;
      delete process.env.ENGRAMER_BOOKEND_HEAD_BYTES;
      delete process.env.ENGRAMER_BOOKEND_TAIL_BYTES;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reads the key layout, defaulting flat and refusing the unknown", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      expect(loadConfig({ dataDir }).s3!.keyLayout).toBe("flat");
      process.env.ENGRAMER_S3_KEY_LAYOUT = "sharded";
      expect(loadConfig({ dataDir }).s3!.keyLayout).toBe("sharded");
      process.env.ENGRAMER_S3_KEY_LAYOUT = "nested";
      expect(() => loadConfig({ dataDir })).toThrow(/ENGRAMER_S3_KEY_LAYOUT/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown checksum mode", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_S3_CHECKSUMS = "sometimes";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      expect(() => loadConfig({ dataDir })).toThrow(/ENGRAMER_S3_CHECKSUMS/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("selects a filesystem derived destination with its own directory", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_DERIVED_BACKEND = "fs";
    process.env.ENGRAMER_DERIVED_DIR = "/tmp/engram-derived-test";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.derivedFsDir).toBe("/tmp/engram-derived-test");
      expect(config.s3Derived).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("defaults the filesystem derived directory into the data dir", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_DERIVED_BACKEND = "fs";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      const config = loadConfig({ dataDir });
      expect(config.derivedFsDir).toBe(join(dataDir, "derived"));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses two derived destinations at once", () => {
    process.env.ENGRAMER_S3_BUCKET = "main";
    process.env.ENGRAMER_S3_ACCESS_KEY = "ak";
    process.env.ENGRAMER_S3_SECRET_KEY = "sk";
    process.env.ENGRAMER_DERIVED_BACKEND = "fs";
    process.env.ENGRAMER_S3_DERIVED_BUCKET = "derived";
    const dataDir = mkdtempSync(join(tmpdir(), "engramer-config-"));
    try {
      expect(() => loadConfig({ dataDir })).toThrow(/derived/);
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
