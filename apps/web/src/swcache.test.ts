import { describe, expect, it } from "vitest";
import { ChunkCache } from "./swcache";

function bytes(tag: number): Uint8Array {
  return new Uint8Array([tag, tag, tag]);
}

/** A controllable fetch: the test decides when chunks land. */
function opener(cache: ChunkCache, fileId: string, windowChunks: number) {
  const calls: number[] = [];
  let release: (() => void) | null = null;
  const make = (firstChunk: number): { lastChunk: number; done: Promise<void> } => {
    calls.push(firstChunk);
    const done = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return { lastChunk: firstChunk + windowChunks - 1, done };
  };
  return {
    calls,
    make,
    deliver(index: number) {
      cache.insert(fileId, index, bytes(index));
    },
    finish() {
      release?.();
    },
  };
}

describe("ChunkCache", () => {
  it("serves cached chunks without fetching", async () => {
    const cache = new ChunkCache(8);
    cache.insert("f", 3, bytes(3));
    const fetcher = opener(cache, "f", 4);
    expect(await cache.ensure("f", 3, fetcher.make)).toEqual(bytes(3));
    expect(fetcher.calls).toEqual([]);
  });

  it("coalesces concurrent wants onto one windowed fetch", async () => {
    const cache = new ChunkCache(8);
    const fetcher = opener(cache, "f", 4);
    const wants = Promise.all([
      cache.ensure("f", 5, fetcher.make),
      cache.ensure("f", 5, fetcher.make),
      cache.ensure("f", 7, fetcher.make),
    ]);
    await new Promise((r) => setTimeout(r, 5));
    expect(fetcher.calls).toEqual([5]);
    fetcher.deliver(5);
    fetcher.deliver(6);
    fetcher.deliver(7);
    fetcher.finish();
    const [a, b, c] = await wants;
    expect(a).toEqual(bytes(5));
    expect(b).toEqual(bytes(5));
    expect(c).toEqual(bytes(7));
  });

  it("resolves waiters null when the fetch dies before their chunk", async () => {
    const cache = new ChunkCache(8);
    const fetcher = opener(cache, "f", 4);
    const want = cache.ensure("f", 9, fetcher.make);
    fetcher.deliver(8);
    fetcher.finish();
    expect(await want).toBeNull();
  });

  it("a chunk outside any in-flight window starts its own fetch", async () => {
    const cache = new ChunkCache(8);
    const fetcher = opener(cache, "f", 4);
    void cache.ensure("f", 0, fetcher.make);
    void cache.ensure("f", 50, fetcher.make);
    await new Promise((r) => setTimeout(r, 5));
    expect(fetcher.calls).toEqual([0, 50]);
  });

  it("evicts least-recently-used chunks past the budget", () => {
    const cache = new ChunkCache(3);
    cache.insert("f", 0, bytes(0));
    cache.insert("f", 1, bytes(1));
    cache.insert("f", 2, bytes(2));
    expect(cache.get("f", 0)).toEqual(bytes(0)); // touch 0
    cache.insert("f", 3, bytes(3)); // evicts 1
    expect(cache.get("f", 1)).toBeUndefined();
    expect(cache.get("f", 0)).toEqual(bytes(0));
    expect(cache.get("f", 3)).toEqual(bytes(3));
  });

  it("readyAhead counts cached and in-flight coverage", async () => {
    const cache = new ChunkCache(8);
    cache.insert("f", 11, bytes(11));
    const fetcher = opener(cache, "f", 4);
    cache.start("f", 12, fetcher.make); // covers 12..15
    expect(cache.readyAhead("f", 10, 5)).toBe(5);
    expect(cache.readyAhead("f", 20, 5)).toBe(0);
    fetcher.finish();
  });

  it("drop forgets one file's chunks only", () => {
    const cache = new ChunkCache(8);
    cache.insert("f", 0, bytes(0));
    cache.insert("g", 0, bytes(9));
    cache.drop("f");
    expect(cache.get("f", 0)).toBeUndefined();
    expect(cache.get("g", 0)).toEqual(bytes(9));
  });
});
