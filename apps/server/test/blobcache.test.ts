import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { byteLimiter, type BlobStore, type PartReceipt } from "../src/blobs.js";
import { DiskCachedBlobStore } from "../src/blobcache.js";

/** In-memory backing store that counts round trips. */
class CountingStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  gets = 0;

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
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
      throw new Error("missing blob");
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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "engramer-cache-"));
}

const put = (store: BlobStore, key: string, bytes: Buffer) =>
  store.put(key, Readable.from(bytes), 1024 * 1024);

describe("disk cached blob store", () => {
  it("serves the second read from disk without touching the backing store", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      const bytes = Buffer.from("thumbnail ciphertext");
      await put(cache, "file-1.thumb", bytes);

      expect(await drain(await cache.get("file-1.thumb"))).toEqual(bytes);
      expect(backing.gets).toBe(1);
      expect(await drain(await cache.get("file-1.thumb"))).toEqual(bytes);
      expect(backing.gets).toBe(1); // hit: no second round trip
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never caches content blobs", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      const bytes = Buffer.from("file content ciphertext");
      await put(cache, "0f0f0f0f-file", bytes);
      await cache.get("0f0f0f0f-file");
      await cache.get("0f0f0f0f-file");
      expect(backing.gets).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates on overwrite so stale bytes can never be served", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      await put(cache, "file-1.idx", Buffer.from("old index"));
      await cache.get("file-1.idx"); // warm the cache
      const fresh = Buffer.from("new index");
      await put(cache, "file-1.idx", fresh);
      expect(await drain(await cache.get("file-1.idx"))).toEqual(fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the entry on remove", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      await put(cache, "file-1.thumb", Buffer.from("bytes"));
      await cache.get("file-1.thumb");
      await cache.remove("file-1.thumb");
      expect(readdirSync(dir)).toEqual([]);
      await expect(cache.get("file-1.thumb")).rejects.toThrow("missing blob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts least-recently-used entries to stay inside the budget", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 250);
      const bytes = Buffer.alloc(100, 7);
      await put(cache, "a.thumb", bytes);
      await put(cache, "b.thumb", bytes);
      await put(cache, "c.thumb", bytes);
      await cache.get("a.thumb");
      await cache.get("b.thumb");
      await cache.get("a.thumb"); // a is now most recently used
      await cache.get("c.thumb"); // 300 bytes cached > 250: b (LRU) evicted
      // Eviction unlinks lazily (evicted bytes are never stale, so the file
      // removal does not need to block the read); wait for it to land.
      for (let i = 0; i < 50 && readdirSync(dir).length > 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const cached = readdirSync(dir).sort();
      expect(cached).toEqual(["a.thumb", "c.thumb"]);
      backing.blobs.delete("a.thumb"); // prove the next read is a cache hit
      expect(await drain(await cache.get("a.thumb"))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds the index from disk after a restart", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const first = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      const bytes = Buffer.from("survives restarts");
      await put(first, "file-1.thumb", bytes);
      await first.get("file-1.thumb");

      const second = new DiskCachedBlobStore(backing, dir, 1024 * 1024);
      backing.blobs.delete("file-1.thumb"); // only the cache can answer now
      expect(await drain(await second.get("file-1.thumb"))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams oversized entries through without admitting them", async () => {
    const dir = tempDir();
    try {
      const backing = new CountingStore();
      const cache = new DiskCachedBlobStore(backing, dir, 400); // per-entry cap 200
      const big = Buffer.alloc(300, 9);
      await put(cache, "big.idx", big);
      expect(await drain(await cache.get("big.idx"))).toEqual(big);
      expect(readdirSync(dir)).toEqual([]);
      expect(await drain(await cache.get("big.idx"))).toEqual(big);
      expect(backing.gets).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
