import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { createWriteStream, existsSync } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobRange, BlobStore, PartReceipt } from "./blobs.js";

/**
 * Disk cache for content blobs in aligned ciphertext windows, in front of a
 * remote blob store. Media playback reads the same regions repeatedly (range
 * cycling, replays, several viewers of one file); against a rate-limited
 * object store each avoided request matters more than each avoided byte.
 *
 * Reads stay latency-honest: a request over uncached windows streams from
 * the backing store immediately, exactly as it would without the cache,
 * while the windows it touched fill in the background (one fill per window,
 * concurrent claimants coalesced). The next reader of those windows never
 * leaves the pod. Uploads warm their first and last windows on commit, so
 * the just-uploaded video that gets played immediately, and the tail-first
 * index reads media containers open with, are served locally from minute
 * one. Content keys are immutable per generation, so nothing here can ever
 * serve stale bytes; invalidation is deletion.
 */
export class MediaWindowCache implements BlobStore {
  /** Content blob keys: a bare file id or an explicit generation. */
  private static readonly CONTENT = /^[A-Za-z0-9-]+(\.g\d+)?$/;
  private static readonly WINDOW_FILE = /\.w\d+\.win$/;

  /** Insertion order is recency order: a touch re-inserts at the tail. */
  private readonly index = new Map<string, number>();
  private totalBytes = 0;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private fillsActive = 0;
  private static readonly FILLS_MAX = 3;
  /** Part sizes per open session, so completeParts knows the blob size. */
  private readonly partBytes = new Map<string, Map<number, number>>();

  constructor(
    private readonly backing: BlobStore,
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly windowBytes = 32 * 1024 * 1024,
  ) {
    mkdirSync(dir, { recursive: true });
    const found: Array<{ name: string; size: number; mtime: number }> = [];
    for (const name of readdirSync(dir)) {
      if (!MediaWindowCache.WINDOW_FILE.test(name)) {
        continue; // leftover temp files and strangers are not index material
      }
      try {
        const info = statSync(join(dir, name));
        found.push({ name, size: info.size, mtime: info.mtimeMs });
      } catch {
        // raced away; nothing to index
      }
    }
    found.sort((a, b) => a.mtime - b.mtime);
    for (const entry of found) {
      this.index.set(entry.name, entry.size);
      this.totalBytes += entry.size;
    }
    this.evict();
  }

  private cacheable(key: string): boolean {
    return MediaWindowCache.CONTENT.test(key);
  }

  private windowName(key: string, window: number): string {
    return `${key}.w${window}.win`;
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private evict(): void {
    for (const [name, size] of this.index) {
      if (this.totalBytes <= this.maxBytes) {
        break;
      }
      this.index.delete(name);
      this.totalBytes -= size;
      void unlink(this.path(name)).catch(() => {});
    }
  }

  private has(name: string): boolean {
    return this.index.has(name) && existsSync(this.path(name));
  }

  private touch(name: string): void {
    const size = this.index.get(name);
    if (size !== undefined) {
      this.index.delete(name);
      this.index.set(name, size);
    }
  }

  /**
   * Fills one window from the backing store, coalescing concurrent
   * claimants. Best-effort: a failed fill resolves false and the window
   * simply stays cold; the serve-through path already has the bytes.
   */
  private fill(key: string, window: number, totalBytes?: number): Promise<boolean> {
    const name = this.windowName(key, window);
    if (this.has(name)) {
      return Promise.resolve(true);
    }
    const running = this.inflight.get(name);
    if (running) {
      return running;
    }
    const task = (async () => {
      if (this.fillsActive >= MediaWindowCache.FILLS_MAX) {
        return false; // shed load instead of queueing a fill storm
      }
      this.fillsActive++;
      const tmp = this.path(`.fill-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        const start = window * this.windowBytes;
        const source = await this.backing.get(
          key,
          { start, end: start + this.windowBytes - 1 },
          totalBytes,
        );
        await pipeline(source, createWriteStream(tmp, { mode: 0o600 }));
        const written = (await stat(tmp)).size;
        await rename(tmp, this.path(name));
        const prior = this.index.get(name);
        if (prior !== undefined) {
          this.index.delete(name);
          this.totalBytes -= prior;
        }
        this.index.set(name, written);
        this.totalBytes += written;
        this.evict();
        return true;
      } catch {
        await unlink(tmp).catch(() => {});
        return false;
      } finally {
        this.fillsActive--;
        this.inflight.delete(name);
      }
    })();
    this.inflight.set(name, task);
    return task;
  }

  /** Warms the windows every playback start touches: the head, and the
   * tail where media containers keep their index. */
  private warm(key: string, size: number): void {
    if (!this.cacheable(key) || size <= 0 || this.maxBytes <= 0) {
      return;
    }
    void this.fill(key, 0, size);
    const last = Math.floor((size - 1) / this.windowBytes);
    if (last > 0) {
      void this.fill(key, last, size);
    }
  }

  async get(key: string, range?: BlobRange, totalBytes?: number): Promise<Readable> {
    if (!range || !this.cacheable(key) || this.maxBytes <= 0) {
      return this.backing.get(key, range, totalBytes);
    }
    const firstWindow = Math.floor(range.start / this.windowBytes);
    const lastWindow = Math.floor(range.end / this.windowBytes);
    const windowBytes = this.windowBytes;
    const self = this;

    async function* serve(): AsyncGenerator<Buffer> {
      for (let w = firstWindow; w <= lastWindow; w++) {
        const name = self.windowName(key, w);
        const windowStart = w * windowBytes;
        const from = Math.max(range!.start, windowStart) - windowStart;
        const to = Math.min(range!.end, windowStart + windowBytes - 1) - windowStart;
        if (self.has(name)) {
          self.touch(name);
          const file = createReadStream(self.path(name), { start: from, end: to });
          for await (const chunk of file) {
            yield chunk as Buffer;
          }
          continue;
        }
        // Cold from here on: one backing request covers the rest of the
        // range at full latency honesty, while the touched windows fill in
        // the background for every reader that comes after.
        for (let missed = w; missed <= lastWindow; missed++) {
          void self.fill(key, missed, totalBytes);
        }
        const rest = await self.backing.get(
          key,
          { start: windowStart + from, end: range!.end },
          totalBytes,
        );
        for await (const chunk of rest) {
          yield chunk as Buffer;
        }
        return;
      }
    }

    return Readable.from(serve());
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const written = await this.backing.put(key, source, maxBytes);
    this.warm(key, written);
    return written;
  }

  /**
   * Resolves once no fill is in flight, which is the point at which every
   * window that was going to appear both exists on disk and is known to the
   * index. Filling is deliberately background work, so an upload returns
   * well before its windows are usable and the two facts land a tick apart;
   * anything observing the cache from outside needs this to tell the
   * difference between "not warm yet" and "not warming".
   */
  async quiet(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  async remove(key: string): Promise<void> {
    await this.backing.remove(key);
    if (!this.cacheable(key)) {
      return;
    }
    const prefix = `${key}.w`;
    for (const [name, size] of [...this.index]) {
      if (name.startsWith(prefix) && MediaWindowCache.WINDOW_FILE.test(name)) {
        this.index.delete(name);
        this.totalBytes -= size;
        await unlink(this.path(name)).catch(() => {});
      }
    }
  }

  beginParts(key: string): Promise<string> {
    return this.backing.beginParts(key);
  }

  async putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    const receipt = await this.backing.putPart(key, handle, partNo, source, length);
    if (this.cacheable(key)) {
      const session = this.partBytes.get(`${key}:${handle}`) ?? new Map<number, number>();
      session.set(partNo, receipt.bytes);
      this.partBytes.set(`${key}:${handle}`, session);
    }
    return receipt;
  }

  async completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
  ): Promise<void> {
    await this.backing.completeParts(key, handle, parts);
    const session = this.partBytes.get(`${key}:${handle}`);
    this.partBytes.delete(`${key}:${handle}`);
    if (session) {
      let total = 0;
      for (const part of parts) {
        total += session.get(part.partNo) ?? 0;
      }
      this.warm(key, total);
    }
  }

  async abortParts(key: string, handle: string): Promise<void> {
    this.partBytes.delete(`${key}:${handle}`);
    await this.backing.abortParts(key, handle);
  }
}
