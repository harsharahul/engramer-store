import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { byteLimiter, type BlobRange, type BlobStore, type PartReceipt } from "../src/blobs.js";
import { DiskCachedBlobStore } from "../src/blobcache.js";
import { MediaWindowCache } from "../src/mediacache.js";
import { LoopbackBus } from "./helpers/loopbackbus.js";

/**
 * Two instances each keep a disk cache in front of the same object store.
 * Thumbnails and indexes are overwritten in place, so an overwrite through
 * one instance must drop the other's copy, or it serves the old bytes for
 * as long as they stay cached. The drop travels over the bus; a per-key
 * epoch keeps a read that was in flight during the drop from admitting the
 * bytes it fetched before the overwrite.
 */
class FakeStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  /** Delays the next get() this long, to open a race window. */
  delayNextGetMs = 0;
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

  async get(key: string, range?: BlobRange): Promise<Readable> {
    this.gets++;
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
    }
    if (this.delayNextGetMs > 0) {
      const wait = this.delayNextGetMs;
      this.delayNextGetMs = 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return Readable.from(range ? bytes.subarray(range.start, range.end + 1) : bytes);
  }

  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async beginParts(): Promise<string> {
    return "h";
  }
  async putPart(): Promise<PartReceipt> {
    throw new Error("unused");
  }
  async completeParts(): Promise<void> {
    throw new Error("unused");
  }
  async abortParts(): Promise<void> {}
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("cache invalidation across instances", () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "engramer-cache-inv-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("an overwrite through one instance drops the other's cached copy", async () => {
    const backing = new FakeStore();
    const bus = new LoopbackBus();
    const a = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: bus.attach() });
    const b = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: bus.attach() });
    await a.put("f1.thumb", Readable.from(Buffer.from("old")), 1024);
    expect(await read(await b.get("f1.thumb"))).toEqual(Buffer.from("old"));
    await a.put("f1.thumb", Readable.from(Buffer.from("new")), 1024);
    expect(await read(await b.get("f1.thumb"))).toEqual(Buffer.from("new"));
    await a.remove("f1.thumb");
    await expect(b.get("f1.thumb")).rejects.toThrow();
  });

  it("does not admit bytes fetched before a drop that landed mid-read", async () => {
    const backing = new FakeStore();
    const bus = new LoopbackBus();
    const a = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: bus.attach() });
    const b = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: bus.attach() });
    await a.put("f2.thumb", Readable.from(Buffer.from("old")), 1024);
    backing.delayNextGetMs = 80;
    const slow = b.get("f2.thumb"); // fetches "old", admits after the delay
    await new Promise((resolve) => setTimeout(resolve, 20));
    await a.put("f2.thumb", Readable.from(Buffer.from("new")), 1024); // drop reaches B mid-read
    expect(await read(await slow)).toEqual(Buffer.from("old")); // that reader gets what it fetched
    expect(await read(await b.get("f2.thumb"))).toEqual(Buffer.from("new")); // nobody after it does
  });

  it("drops every derived entry when its bus reconnects after a gap", async () => {
    const backing = new FakeStore();
    const bus = new LoopbackBus();
    const memberB = bus.attach();
    const a = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: bus.attach() });
    const b = new DiskCachedBlobStore(backing, dir(), 1024 * 1024, { bus: memberB });
    await a.put("f3.thumb", Readable.from(Buffer.from("old")), 1024);
    await read(await b.get("f3.thumb"));
    memberB.listening = false;
    await a.put("f3.thumb", Readable.from(Buffer.from("new")), 1024);
    expect(await read(await b.get("f3.thumb"))).toEqual(Buffer.from("old")); // stale while deaf
    await memberB.reconnect();
    expect(await read(await b.get("f3.thumb"))).toEqual(Buffer.from("new"));
  });

  it("a media window cache drops a re-minted content key's windows on every instance", async () => {
    const backing = new FakeStore();
    const bus = new LoopbackBus();
    const WINDOW = 64;
    const a = new MediaWindowCache(backing, dir(), 1024 * 1024, WINDOW, { bus: bus.attach() });
    const b = new MediaWindowCache(backing, dir(), 1024 * 1024, WINDOW, { bus: bus.attach() });
    const first = Buffer.alloc(WINDOW * 2, 1);
    const second = Buffer.alloc(WINDOW * 2, 2);
    await a.put("movie.g3", Readable.from(first), first.length, true);
    await a.quiet();
    expect(await read(await b.get("movie.g3", { start: 0, end: WINDOW - 1 }, first.length))).toEqual(
      first.subarray(0, WINDOW),
    );
    // A version restore then a re-save reuses the key with different bytes.
    await a.put("movie.g3", Readable.from(second), second.length, true);
    await a.quiet();
    await b.quiet();
    expect(await read(await b.get("movie.g3", { start: 0, end: WINDOW - 1 }, second.length))).toEqual(
      second.subarray(0, WINDOW),
    );
  });
});
