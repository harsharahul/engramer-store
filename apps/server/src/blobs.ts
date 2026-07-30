import { createReadStream, createWriteStream, existsSync, unlinkSync } from "node:fs";
import { readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type BlobKind = "data" | "thumb" | "index";

/**
 * Content blobs are append-only across generations: generation 0 keeps the
 * legacy bare key (every pre-versioning blob stays valid), generation N lives
 * at `<id>.g<N>`. A save writes the next generation and only then moves the
 * pointer, so no blob a file row references is ever overwritten in place.
 * The index blob holds the file's encrypted search text, kept out of the
 * metadata row so sync payloads stay small.
 */
export function blobKey(fileId: string, kind: BlobKind, generation = 0): string {
  if (kind === "thumb") {
    return `${fileId}.thumb`;
  }
  if (kind === "index") {
    return `${fileId}.idx`;
  }
  return generation > 0 ? `${fileId}.g${generation}` : fileId;
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the allowed size");
  }
}

export interface PartReceipt {
  bytes: number;
  etag?: string;
}

/** Inclusive byte range of a blob's content. */
export interface BlobRange {
  start: number;
  end: number;
}

/**
 * Where ciphertext lives. The metadata database never holds blob bytes; a
 * store implementation only needs streaming put/get/remove of opaque keys,
 * plus a part-upload session so large blobs can arrive in bounded requests
 * and still land as one ordinary blob under the final key.
 */
export interface BlobStore {
  /** Streams a blob in, enforcing maxBytes; resolves to the byte count. */
  put(key: string, source: Readable, maxBytes: number): Promise<number>;
  /** Streams a blob out, optionally only the given inclusive byte range. */
  get(key: string, range?: BlobRange): Promise<Readable>;
  remove(key: string): Promise<void>;
  /** Opens a part session targeting the key; returns a backend handle. */
  beginParts(key: string): Promise<string>;
  /** Stores one part (1-based). Re-sending a part number replaces it. The
   * body must be exactly `length` bytes; anything else fails the part. */
  putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt>;
  /** Assembles the session's parts into the final blob at the key. */
  completeParts(key: string, handle: string, parts: { partNo: number; etag?: string }[]): Promise<void>;
  /** Discards a session's parts; safe to call on unknown handles. */
  abortParts(key: string, handle: string): Promise<void>;
}

/** Counts bytes flowing through and aborts the stream past maxBytes. */
export function byteLimiter(maxBytes: number): { transform: Transform; written: () => number } {
  let written = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new BlobTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  return { transform, written: () => written };
}

/**
 * Local filesystem store: writes go through a temp file and an atomic rename,
 * so a crashed upload never leaves a partial blob under its final name.
 */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, key);
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const destination = this.path(key);
    const tmp = `${destination}.upload-${process.pid}-${Date.now()}`;
    const limiter = byteLimiter(maxBytes);
    try {
      await pipeline(source, limiter.transform, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, destination);
      return limiter.written();
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    return range
      ? createReadStream(this.path(key), { start: range.start, end: range.end })
      : createReadStream(this.path(key));
  }

  async remove(key: string): Promise<void> {
    if (existsSync(this.path(key))) {
      unlinkSync(this.path(key));
    }
  }

  private partPath(key: string, handle: string, partNo: number): string {
    return this.path(`${key}.parts-${handle}.${partNo}`);
  }

  async beginParts(_key: string): Promise<string> {
    return randomBytes(8).toString("hex");
  }

  async putPart(
    key: string,
    handle: string,
    partNo: number,
    source: Readable,
    length: number,
  ): Promise<PartReceipt> {
    const destination = this.partPath(key, handle, partNo);
    const tmp = `${destination}.upload-${process.pid}-${Date.now()}`;
    const limiter = byteLimiter(length);
    try {
      await pipeline(source, limiter.transform, createWriteStream(tmp, { mode: 0o600 }));
      if (limiter.written() !== length) {
        throw new BlobTooLargeError();
      }
      await rename(tmp, destination);
      return { bytes: limiter.written() };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async completeParts(
    key: string,
    handle: string,
    parts: { partNo: number; etag?: string }[],
  ): Promise<void> {
    const destination = this.path(key);
    const tmp = `${destination}.upload-${process.pid}-${Date.now()}`;
    const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
    try {
      const sink = createWriteStream(tmp, { mode: 0o600 });
      for (const part of ordered) {
        await pipeline(createReadStream(this.partPath(key, handle, part.partNo)), sink, {
          end: false,
        });
      }
      await new Promise<void>((resolve, reject) => {
        sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      await rename(tmp, destination);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    for (const part of ordered) {
      await unlink(this.partPath(key, handle, part.partNo)).catch(() => {});
    }
  }

  async abortParts(key: string, handle: string): Promise<void> {
    const prefix = `${key}.parts-${handle}.`;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith(prefix)) {
        await unlink(this.path(name)).catch(() => {});
      }
    }
  }
}
