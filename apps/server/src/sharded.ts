import type { Readable } from "node:stream";
import type { BlobRange, BlobStore, PartReceipt } from "./blobs.js";

/**
 * Fans a flat key namespace into two directory levels: `abcd-99` is stored
 * at `ab/cd/abcd-99`. Directory-shaped backends (a cloud drive behind an
 * S3 gateway, a plain filesystem) pay per-entry costs on listing and
 * sometimes on lookup; a large library in one directory turns those costs
 * into seconds. The mapping is deterministic and derived from the key
 * alone, so every suffix of a blob (`.thumb`, `.g3`, `.bhead`, window
 * files) lands in the blob's own shard.
 *
 * The layout must be chosen before the first blob is written: existing
 * blobs are not migrated between layouts.
 */
export class ShardedKeyStore implements BlobStore {
  constructor(private readonly inner: BlobStore) {}

  private shard(key: string): string {
    if (key.length < 4) {
      return key; // nothing sensible to shard by; store as-is
    }
    return `${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
  }

  put(key: string, source: Readable, maxBytes: number, seekable?: boolean): Promise<number> {
    return this.inner.put(this.shard(key), source, maxBytes, seekable);
  }

  get(key: string, range?: BlobRange, totalBytes?: number): Promise<Readable> {
    return this.inner.get(this.shard(key), range, totalBytes);
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(this.shard(key));
  }

  beginParts(key: string): Promise<string> {
    return this.inner.beginParts(this.shard(key));
  }

  putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    return this.inner.putPart(this.shard(key), handle, partNo, source, length);
  }

  completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
    seekable?: boolean,
  ): Promise<void> {
    return this.inner.completeParts(this.shard(key), handle, parts, seekable);
  }

  abortParts(key: string, handle: string): Promise<void> {
    return this.inner.abortParts(this.shard(key), handle);
  }
}
