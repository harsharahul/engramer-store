import { Readable } from "node:stream";
import type { BlobStore, PartReceipt } from "./blobs.js";
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

  constructor(
    private readonly primary: BlobStore,
    private readonly derived: BlobStore,
  ) {}

  private isDerived(key: string): boolean {
    return RoutedBlobStore.DERIVED.test(key);
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    return this.isDerived(key)
      ? this.derived.put(key, source, maxBytes)
      : this.primary.put(key, source, maxBytes);
  }

  async get(key: string): Promise<Readable> {
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
  }

  // Part sessions follow the same placement rule as put().
  private backendFor(key: string): BlobStore {
    return this.isDerived(key) ? this.derived : this.primary;
  }

  beginParts(key: string): Promise<string> {
    return this.backendFor(key).beginParts(key);
  }

  putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    return this.backendFor(key).putPart(key, handle, partNo, source, length);
  }

  completeParts(key: string, handle: string, parts: { partNo: number; etag?: string }[]): Promise<void> {
    return this.backendFor(key).completeParts(key, handle, parts);
  }

  abortParts(key: string, handle: string): Promise<void> {
    return this.backendFor(key).abortParts(key, handle);
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
