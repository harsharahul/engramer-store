import { Readable } from "node:stream";
import type { BlobRange, BlobStore, PartReceipt } from "./blobs.js";
import { bufferUpTo } from "./streams.js";

/**
 * Splits blob traffic across two backends by what the bytes are. Content
 * blobs and their versions are byte-heavy and request-light: they belong on
 * cheap, durable storage, rate-limited or not. Derived blobs (thumbnails,
 * search indexes) are byte-light and request-heavy: they belong on a fast,
 * unmetered store close to the server. The two classes have opposite
 * storage economics, and forcing them through one bucket is how a library
 * scroll ends up rate-limited by the store holding the originals.
 *
 * Migration is self-healing: a derived blob that predates the split still
 * lives in the primary bucket, so a miss on the derived backend falls back
 * to primary, serves the bytes, and copies them to the derived backend so
 * the next read routes clean. No operator migration step exists.
 */
export class RoutedBlobStore implements BlobStore {
  private static readonly DERIVED = /\.(thumb|idx)$/;
  /** Fallback copies are buffered; derived blobs are small by construction. */
  private static readonly HEAL_CAP = 4 * 1024 * 1024;
  /** Bookend sizes: every playback start touches a file's head, and media
   * containers keep their index near the tail. Copies of both live on the
   * fast store, so a cold start never pays the slow store's price. The
   * tail is two 32MiB cache windows deep, which always covers the final
   * window and the one before it regardless of how the size divides. */
  static readonly HEAD_BYTES = 32 * 1024 * 1024;
  static readonly TAIL_BYTES = 64 * 1024 * 1024;
  private readonly headBytes: number;
  private readonly tailBytes: number;

  /** Bookend copies being written right now, deduplicated per key. */
  private readonly healing = new Set<string>();
  /** Part sizes per open session, so completeParts knows the blob size. */
  private readonly partBytes = new Map<string, Map<number, number>>();

  constructor(
    private readonly primary: BlobStore,
    private readonly derived: BlobStore,
    geometry?: { headBytes?: number; tailBytes?: number },
  ) {
    this.headBytes = geometry?.headBytes ?? RoutedBlobStore.HEAD_BYTES;
    this.tailBytes = geometry?.tailBytes ?? RoutedBlobStore.TAIL_BYTES;
  }

  private isDerived(key: string): boolean {
    return RoutedBlobStore.DERIVED.test(key);
  }

  async put(key: string, source: Readable, maxBytes: number, seekable?: boolean): Promise<number> {
    if (this.isDerived(key)) {
      return this.derived.put(key, source, maxBytes);
    }
    const written = await this.primary.put(key, source, maxBytes);
    // Eager copies only for content that can be range-read; everything else
    // is fetched whole, so its bookends would be bytes nobody can reach.
    // Blobs from before the flag existed still get theirs through the
    // demand-driven heal in get().
    if (seekable) {
      this.copyBookends(key, written);
    }
    return written;
  }

  /**
   * Copies a content blob's head and tail from the slow store to the fast
   * one, once, in the background. Best-effort: a missing bookend only
   * means the read that wanted it falls back to the slow store.
   */
  private copyBookends(key: string, totalBytes: number): void {
    if (totalBytes <= 0 || this.healing.has(key)) {
      return;
    }
    this.healing.add(key);
    void (async () => {
      try {
        const headEnd = Math.min(this.headBytes, totalBytes) - 1;
        const head = await this.primary.get(key, { start: 0, end: headEnd });
        await this.derived.put(`${key}.bhead`, head, headEnd + 1);
        const tailStart = Math.max(0, totalBytes - this.tailBytes);
        if (tailStart > headEnd) {
          const tail = await this.primary.get(key, { start: tailStart, end: totalBytes - 1 });
          await this.derived.put(`${key}.btail`, tail, totalBytes - tailStart);
        }
      } catch {
        // The slow store still holds the truth; a later read retries.
      } finally {
        this.healing.delete(key);
      }
    })();
  }

  async get(key: string, range?: BlobRange, totalBytes?: number): Promise<Readable> {
    if (range) {
      if (!this.isDerived(key) && totalBytes !== undefined && totalBytes > 0) {
        const headEnd = Math.min(this.headBytes, totalBytes) - 1;
        const tailStart = Math.max(0, totalBytes - this.tailBytes);
        try {
          if (range.end <= headEnd) {
            return await this.derived.get(`${key}.bhead`, range);
          }
          if (range.start >= tailStart && tailStart > headEnd) {
            return await this.derived.get(`${key}.btail`, {
              start: range.start - tailStart,
              end: range.end - tailStart,
            });
          }
        } catch (err) {
          if (!isMissingBlob(err)) {
            throw err;
          }
          // Pre-bookend blob: serve slow, and put the bookends in place
          // for every read after this one.
          this.copyBookends(key, totalBytes);
        }
      }
      // Ranged reads route directly and never trigger the derived-heal
      // copy for derived keys.
      return this.backendFor(key).get(key, range);
    }
    if (!this.isDerived(key)) {
      return this.primary.get(key);
    }
    try {
      return await this.derived.get(key);
    } catch (err) {
      if (!isMissingBlob(err)) {
        throw err;
      }
    }
    // Pre-split blob: serve from primary and heal the split on the way out.
    const source = await this.primary.get(key);
    const result = await bufferUpTo(source, RoutedBlobStore.HEAL_CAP);
    if (result.kind === "stream") {
      return result.stream; // oversized for healing; serve it and move on
    }
    try {
      await this.derived.put(key, Readable.from(result.bytes), result.bytes.length);
    } catch {
      // Healing is best-effort; the primary copy keeps serving reads.
    }
    return Readable.from(result.bytes);
  }

  async remove(key: string): Promise<void> {
    if (this.isDerived(key)) {
      // A pre-split copy may still sit in primary; a delete must kill both
      // or deleted ciphertext would linger in the content bucket.
      await this.derived.remove(key);
      await this.primary.remove(key);
      return;
    }
    await this.primary.remove(key);
    // Bookend ciphertext must not outlive the blob it copies.
    await this.derived.remove(`${key}.bhead`).catch(() => {});
    await this.derived.remove(`${key}.btail`).catch(() => {});
  }

  // Part sessions follow the same placement rule as put().
  private backendFor(key: string): BlobStore {
    return this.isDerived(key) ? this.derived : this.primary;
  }

  beginParts(key: string): Promise<string> {
    return this.backendFor(key).beginParts(key);
  }

  async putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    const receipt = await this.backendFor(key).putPart(key, handle, partNo, source, length);
    if (!this.isDerived(key)) {
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
    seekable?: boolean,
  ): Promise<void> {
    await this.backendFor(key).completeParts(key, handle, parts);
    const session = this.partBytes.get(`${key}:${handle}`);
    this.partBytes.delete(`${key}:${handle}`);
    if (session && seekable && !this.isDerived(key)) {
      let total = 0;
      for (const part of parts) {
        total += session.get(part.partNo) ?? 0;
      }
      this.copyBookends(key, total);
    }
  }

  async abortParts(key: string, handle: string): Promise<void> {
    this.partBytes.delete(`${key}:${handle}`);
    await this.backendFor(key).abortParts(key, handle);
  }
}

/** Recognizes the S3 family of not-found errors without importing the SDK. */
function isMissingBlob(err: unknown): boolean {
  const shaped = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    shaped?.name === "NoSuchKey" ||
    shaped?.name === "NotFound" ||
    shaped?.Code === "NoSuchKey" ||
    shaped?.$metadata?.httpStatusCode === 404
  );
}
