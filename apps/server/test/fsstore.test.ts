import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BlobNotFoundError, FsBlobStore } from "../src/blobs.js";

const dirs: string[] = [];

function makeStore(): FsBlobStore {
  const dir = mkdtempSync(join(tmpdir(), "fsstore-"));
  dirs.push(dir);
  return new FsBlobStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The filesystem store must refuse a missing key at get() time, not hand
 * back a stream that errors mid-pipe. Tiered stores above it decide
 * fallback and healing by catching a not-found from get(); an error that
 * only surfaces on first read arrives after that decision point has
 * passed, so a late ENOENT silently disables every fallback path.
 */
describe("fs blob store missing keys", () => {
  it("get of a missing key rejects with the store-agnostic not-found", async () => {
    const store = makeStore();
    await expect(store.get("no-such-blob")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("a ranged get of a missing key rejects the same way", async () => {
    const store = makeStore();
    await expect(store.get("no-such-blob", { start: 0, end: 7 })).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });

  it("a present key still streams, whole and ranged", async () => {
    const store = makeStore();
    const bytes = Buffer.from("0123456789");
    await store.put("blob-1", Readable.from(bytes), 1024);
    const whole: Buffer[] = [];
    for await (const chunk of await store.get("blob-1")) {
      whole.push(chunk as Buffer);
    }
    expect(Buffer.concat(whole)).toEqual(bytes);
    const ranged: Buffer[] = [];
    for await (const chunk of await store.get("blob-1", { start: 2, end: 5 })) {
      ranged.push(chunk as Buffer);
    }
    expect(Buffer.concat(ranged)).toEqual(Buffer.from("2345"));
  });

  /**
   * A stream handed out by get() owns the bytes it will read. It used to be
   * opened lazily after an existence check, so a delete in between (an
   * account deletion racing a download) made the stream fail on its own,
   * with nothing listening: an uncaught exception that took a CI run down
   * and could take the server with it.
   */
  it("a stream already handed out survives the blob being removed", async () => {
    const store = makeStore();
    const bytes = Buffer.from("still here");
    await store.put("blob-2", Readable.from(bytes), 1024);
    const stream = await store.get("blob-2");
    await store.remove("blob-2");
    const read: Buffer[] = [];
    for await (const chunk of stream) {
      read.push(chunk as Buffer);
    }
    expect(Buffer.concat(read)).toEqual(bytes);
    await expect(store.get("blob-2")).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});
