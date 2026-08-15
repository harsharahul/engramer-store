import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BlobRange, BlobStore, PartReceipt } from "./blobs.js";
import { bufferUpTo } from "./streams.js";

/**
 * Read-through disk cache in front of a remote blob store, for the small
 * derived blobs (thumbnails and search indexes) that dominate request counts:
 * a grid paint or a search warm touches hundreds of them, and against a
 * rate-limited object store every avoided round trip matters.
 *
 * Content blobs pass straight through untouched. Derived blobs are the one
 * blob class overwritten in place, so coherence is by invalidation: put and
 * remove drop the cache entry and the next read re-fills it, which can never
 * serve stale bytes. The cache directory is disposable state: entries are
 * written via temp file + atomic rename (never servable half-written), and a
 * startup rescan rebuilds the index, evicting down to budget by mtime.
 * Single-process by design, like the SQLite database next to it.
 */
export class DiskCachedBlobStore implements BlobStore {
  /** Keys eligible for caching: derived blobs with our uuid naming. */
  private static readonly CACHEABLE = /^[A-Za-z0-9-]+\.(thumb|idx)$/;

  /** Insertion order is recency order: a touch re-inserts at the tail. */
  private readonly index = new Map<string, number>();
  private totalBytes = 0;
  private readonly perEntryCap: number;

  constructor(
    private readonly backing: BlobStore,
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {
    // A single entry may not squeeze everything else out of a small budget.
    this.perEntryCap = Math.min(4 * 1024 * 1024, Math.floor(maxBytes / 2));
    mkdirSync(dir, { recursive: true });
    const found: Array<{ key: string; size: number; mtime: number }> = [];
    for (const name of readdirSync(dir)) {
      if (!DiskCachedBlobStore.CACHEABLE.test(name)) {
        continue; // leftover temp files and strangers are not index material
      }
      try {
        const stat = statSync(join(dir, name));
        found.push({ key: name, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // raced away; nothing to index
      }
    }
    found.sort((a, b) => a.mtime - b.mtime);
    for (const entry of found) {
      this.index.set(entry.key, entry.size);
      this.totalBytes += entry.size;
    }
    this.evict();
  }

  private cacheable(key: string): boolean {
    return DiskCachedBlobStore.CACHEABLE.test(key);
  }

  private path(key: string): string {
    return join(this.dir, key);
  }

  /** Drops least-recently-used entries until the budget holds. */
  private evict(): void {
    for (const [key, size] of this.index) {
      if (this.totalBytes <= this.maxBytes) {
        break;
      }
      this.index.delete(key);
      this.totalBytes -= size;
      void unlink(this.path(key)).catch(() => {});
    }
  }

  /**
   * Durable invalidation: the file must be gone before this resolves, or a
   * restart's rescan could resurrect stale bytes into the index. Eviction,
   * by contrast, removes entries that still match the backing store, so its
   * lazy unlink is safe.
   */
  private async drop(key: string): Promise<void> {
    const size = this.index.get(key);
    if (size !== undefined) {
      this.index.delete(key);
      this.totalBytes -= size;
    }
    await unlink(this.path(key)).catch(() => {});
  }

  private async admit(key: string, bytes: Buffer): Promise<void> {
    const tmp = join(this.dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, this.path(key));
    } catch {
      await unlink(tmp).catch(() => {});
      return; // cache admission is best-effort; the backing store answered
    }
    const prior = this.index.get(key);
    if (prior !== undefined) {
      this.index.delete(key);
      this.totalBytes -= prior;
    }
    this.index.set(key, bytes.length);
    this.totalBytes += bytes.length;
    this.evict();
  }

  async get(key: string, range?: BlobRange, totalBytes?: number): Promise<Readable> {
    if (range) {
      // Ranged reads never involve the cache; content blobs are not cached.
      return this.backing.get(key, range, totalBytes);
    }
    if (!this.cacheable(key)) {
      return this.backing.get(key);
    }
    const size = this.index.get(key);
    if (size !== undefined && existsSync(this.path(key))) {
      // Touch: re-insert at the recency tail.
      this.index.delete(key);
      this.index.set(key, size);
      return createReadStream(this.path(key));
    }
    const source = await this.backing.get(key);
    // Derived blobs are small; buffer up to the cap so the bytes can be both
    // served and admitted. Past the cap, serve straight through, no admission.
    const result = await bufferUpTo(source, this.perEntryCap);
    if (result.kind === "stream") {
      return result.stream;
    }
    await this.admit(key, result.bytes);
    return Readable.from(result.bytes);
  }

  async put(key: string, source: Readable, maxBytes: number, seekable?: boolean): Promise<number> {
    const written = await this.backing.put(key, source, maxBytes, seekable);
    if (this.cacheable(key)) {
      await this.drop(key); // overwritten in place upstream; never serve the old bytes
    }
    return written;
  }

  async remove(key: string): Promise<void> {
    await this.backing.remove(key);
    if (this.cacheable(key)) {
      await this.drop(key);
    }
  }

  // Part sessions only ever carry content blobs, which this cache never
  // holds; they pass straight through.

  beginParts(key: string): Promise<string> {
    return this.backing.beginParts(key);
  }

  putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    return this.backing.putPart(key, handle, partNo, source, length);
  }

  completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
    seekable?: boolean,
  ): Promise<void> {
    return this.backing.completeParts(key, handle, parts, seekable);
  }

  abortParts(key: string, handle: string): Promise<void> {
    return this.backing.abortParts(key, handle);
  }
}
