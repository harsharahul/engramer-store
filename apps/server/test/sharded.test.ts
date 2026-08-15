import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FsBlobStore, type BlobRange, type BlobStore, type PartReceipt } from "../src/blobs.js";
import { ShardedKeyStore } from "../src/sharded.js";

/** Records every key the inner store is asked for. */
class RecordingStore implements BlobStore {
  readonly keys: string[] = [];
  readonly blobs = new Map<string, Buffer>();

  async put(key: string, source: Readable, _maxBytes: number): Promise<number> {
    this.keys.push(`put:${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      chunks.push(chunk as Buffer);
    }
    this.blobs.set(key, Buffer.concat(chunks));
    return this.blobs.get(key)!.length;
  }

  async get(key: string, _range?: BlobRange): Promise<Readable> {
    this.keys.push(`get:${key}`);
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    }
    return Readable.from(bytes);
  }

  async remove(key: string): Promise<void> {
    this.keys.push(`remove:${key}`);
    this.blobs.delete(key);
  }

  async beginParts(key: string): Promise<string> {
    this.keys.push(`begin:${key}`);
    return "h";
  }

  async putPart(
    key: string,
    _handle: string,
    partNo: number,
    _source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    this.keys.push(`part${partNo}:${key}`);
    return { bytes: length };
  }

  async completeParts(key: string): Promise<void> {
    this.keys.push(`complete:${key}`);
  }

  async abortParts(key: string): Promise<void> {
    this.keys.push(`abort:${key}`);
  }
}

describe("sharded key store", () => {
  it("maps every operation's key into a two-level shard", async () => {
    const inner = new RecordingStore();
    const store = new ShardedKeyStore(inner);
    await store.put("abcd-1234", Readable.from(Buffer.from("x")), 10);
    await store.get("abcd-1234");
    await store.remove("abcd-1234");
    const handle = await store.beginParts("abcd-1234");
    await store.putPart("abcd-1234", handle, 1, Readable.from(Buffer.from("y")), 1);
    await store.completeParts("abcd-1234", handle, [{ partNo: 1 }]);
    await store.abortParts("abcd-1234", handle);
    expect(inner.keys).toEqual([
      "put:ab/cd/abcd-1234",
      "get:ab/cd/abcd-1234",
      "remove:ab/cd/abcd-1234",
      "begin:ab/cd/abcd-1234",
      "part1:ab/cd/abcd-1234",
      "complete:ab/cd/abcd-1234",
      "abort:ab/cd/abcd-1234",
    ]);
  });

  it("keeps a blob's derived keys in the blob's own shard", async () => {
    const inner = new RecordingStore();
    const store = new ShardedKeyStore(inner);
    for (const key of ["abcd-1.thumb", "abcd-1.idx", "abcd-1.bhead", "abcd-1.g3", "abcd-1.w2.win"]) {
      await store.put(key, Readable.from(Buffer.from("x")), 10);
    }
    expect(inner.keys).toEqual([
      "put:ab/cd/abcd-1.thumb",
      "put:ab/cd/abcd-1.idx",
      "put:ab/cd/abcd-1.bhead",
      "put:ab/cd/abcd-1.g3",
      "put:ab/cd/abcd-1.w2.win",
    ]);
  });

  it("forwards the seekable hint unchanged", async () => {
    const seen: Array<boolean | undefined> = [];
    const inner = new RecordingStore();
    inner.put = async (key, source, _max, seekable?: boolean) => {
      seen.push(seekable);
      for await (const _ of source) void _;
      return 1;
    };
    const store = new ShardedKeyStore(inner);
    await store.put("abcd-1", Readable.from(Buffer.from("x")), 10, true);
    expect(seen).toEqual([true]);
  });

  it("round-trips bytes through a real filesystem store underneath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sharded-fs-"));
    try {
      const store = new ShardedKeyStore(new FsBlobStore(dir));
      const bytes = Buffer.from("sharded body");
      await store.put("abcd-777", Readable.from(bytes), 1024);
      expect(existsSync(join(dir, "ab", "cd", "abcd-777"))).toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of await store.get("abcd-777")) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
      await store.remove("abcd-777");
      expect(existsSync(join(dir, "ab", "cd", "abcd-777"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
