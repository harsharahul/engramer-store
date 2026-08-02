import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { byteLimiter, type BlobRange, type BlobStore, type PartReceipt } from "../src/blobs.js";
import { MediaWindowCache } from "../src/mediacache.js";

const WINDOW = 64;

/** In-memory ranged backing store that counts round trips. */
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

  async get(key: string, range?: BlobRange): Promise<Readable> {
    this.gets++;
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw new Error("missing blob");
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

  private partData = new Map<string, Buffer>();

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
    this.partData.set(`${key}:${handle}:${partNo}`, Buffer.concat(chunks));
    return { bytes: limiter.written() };
  }

  async completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
    const chunks = ordered.map((p) => this.partData.get(`${key}:${handle}:${p.partNo}`) ?? Buffer.alloc(0));
    this.blobs.set(key, Buffer.concat(chunks));
  }

  async abortParts(_key: string, _handle: string): Promise<void> {}
}

function patterned(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return bytes;
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function windowFiles(dir: string): number {
  return readdirSync(dir).filter((name) => name.endsWith(".win")).length;
}

/** Waits for background fills to stop touching the backing store: two
 * consecutive polls with an unchanged count mean nothing is in flight,
 * which a file-count poll alone cannot promise (a window is usable only
 * once its index entry follows the file onto disk). */
async function settle(backing: CountingStore): Promise<number> {
  let last = -1;
  await until(() => {
    const now = backing.gets;
    const stable = now === last;
    last = now;
    return stable;
  });
  return backing.gets;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const dirs: string[] = [];

function makeCache(backing: BlobStore, maxBytes = 1024 * 1024): { cache: MediaWindowCache; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mediacache-"));
  dirs.push(dir);
  return { cache: new MediaWindowCache(backing, dir, maxBytes, WINDOW), dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MediaWindowCache", () => {
  it("passes through unranged reads and derived keys untouched", async () => {
    const backing = new CountingStore();
    backing.blobs.set("file-1", patterned(100));
    backing.blobs.set("file-1.thumb", patterned(10));
    const { cache, dir } = makeCache(backing);
    expect(await read(await cache.get("file-1"))).toEqual(patterned(100));
    expect(await read(await cache.get("file-1.thumb", { start: 0, end: 4 }))).toEqual(
      patterned(10).subarray(0, 5),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("serves a cold range through immediately and fills the windows behind it", async () => {
    const backing = new CountingStore();
    const blob = patterned(WINDOW * 3);
    backing.blobs.set("file-2", blob);
    const { cache, dir } = makeCache(backing);
    const got = await read(await cache.get("file-2", { start: 10, end: WINDOW * 2 + 5 }));
    expect(got).toEqual(blob.subarray(10, WINDOW * 2 + 6));
    // One serve-through plus one fill per touched window, never more.
    await until(() => windowFiles(dir) === 3);
    const cold = await settle(backing);
    expect(cold).toBeLessThanOrEqual(4);
    const warm = await read(await cache.get("file-2", { start: 10, end: WINDOW * 2 + 5 }));
    expect(warm).toEqual(blob.subarray(10, WINDOW * 2 + 6));
    expect(backing.gets).toBe(cold);
  });

  it("stitches warm windows byte-exactly, including the short tail window", async () => {
    const backing = new CountingStore();
    const blob = patterned(WINDOW * 2 + 17);
    backing.blobs.set("file-3", blob);
    const { cache, dir } = makeCache(backing);
    await read(await cache.get("file-3", { start: 0, end: blob.length - 1 }));
    await until(() => windowFiles(dir) === 3);
    const cold = await settle(backing);
    expect(cold).toBeLessThanOrEqual(4);
    const whole = await read(await cache.get("file-3", { start: 0, end: blob.length - 1 }));
    expect(whole).toEqual(blob);
    const cross = await read(await cache.get("file-3", { start: WINDOW - 3, end: WINDOW * 2 + 2 }));
    expect(cross).toEqual(blob.subarray(WINDOW - 3, WINDOW * 2 + 3));
    expect(backing.gets).toBe(cold);
  });

  it("coalesces concurrent fills of the same window", async () => {
    const backing = new CountingStore();
    backing.blobs.set("file-4", patterned(WINDOW));
    const { cache } = makeCache(backing);
    const [a, b] = await Promise.all([
      cache.get("file-4", { start: 0, end: WINDOW - 1 }).then(read),
      cache.get("file-4", { start: 0, end: WINDOW - 1 }).then(read),
    ]);
    expect(a).toEqual(patterned(WINDOW));
    expect(b).toEqual(patterned(WINDOW));
    // 2 serve-throughs + at most 1 fill for the shared window.
    await until(() => backing.gets >= 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(backing.gets).toBeLessThanOrEqual(3);
  });

  it("warms the head and tail windows when an upload commits", async () => {
    const backing = new CountingStore();
    const blob = patterned(WINDOW * 4 + 9);
    const { cache, dir } = makeCache(backing);
    await cache.put("file-5", Readable.from(blob), blob.length);
    await until(() => windowFiles(dir) === 2);
    backing.gets = 0;
    const head = await read(await cache.get("file-5", { start: 0, end: WINDOW - 1 }));
    expect(head).toEqual(blob.subarray(0, WINDOW));
    const tail = await read(await cache.get("file-5", { start: WINDOW * 4, end: blob.length - 1 }));
    expect(tail).toEqual(blob.subarray(WINDOW * 4));
    expect(backing.gets).toBe(0);
  });

  it("warms after a part upload completes, sized from the parts", async () => {
    const backing = new CountingStore();
    const half = patterned(WINDOW * 2).subarray(0, WINDOW);
    const rest = patterned(WINDOW * 2).subarray(WINDOW);
    const { cache, dir } = makeCache(backing);
    const handle = await cache.beginParts("file-6");
    await cache.putPart("file-6", handle, 1, Readable.from(half), half.length);
    await cache.putPart("file-6", handle, 2, Readable.from(rest), rest.length);
    await cache.completeParts("file-6", handle, [{ partNo: 1 }, { partNo: 2 }]);
    await until(() => windowFiles(dir) === 2);
    backing.gets = 0;
    const tail = await read(await cache.get("file-6", { start: WINDOW, end: WINDOW * 2 - 1 }));
    expect(tail).toEqual(rest);
    expect(backing.gets).toBe(0);
  });

  it("remove drops the blob's windows but nobody else's", async () => {
    const backing = new CountingStore();
    backing.blobs.set("file-7", patterned(WINDOW));
    backing.blobs.set("file-7x", patterned(WINDOW));
    const { cache, dir } = makeCache(backing);
    await read(await cache.get("file-7", { start: 0, end: WINDOW - 1 }));
    await read(await cache.get("file-7x", { start: 0, end: WINDOW - 1 }));
    await until(() => windowFiles(dir) === 2);
    await cache.remove("file-7");
    const left = readdirSync(dir);
    expect(left).toEqual(["file-7x.w0.win"]);
  });

  it("evicts least-recently-used windows past the byte budget", async () => {
    const backing = new CountingStore();
    const blob = patterned(WINDOW * 4);
    backing.blobs.set("file-8", blob);
    const { cache, dir } = makeCache(backing, WINDOW * 2);
    for (let w = 0; w < 4; w++) {
      await read(await cache.get("file-8", { start: w * WINDOW, end: (w + 1) * WINDOW - 1 }));
      await until(() => readdirSync(dir).some((n) => n === `file-8.w${w}.win`) || w >= 2, 500).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = readdirSync(dir).filter((n) => n.endsWith(".win"));
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
