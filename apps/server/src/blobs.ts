import { createReadStream, createWriteStream, existsSync, unlinkSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type BlobKind = "data" | "thumb";

export function blobKey(fileId: string, kind: BlobKind): string {
  return kind === "data" ? fileId : `${fileId}.thumb`;
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the allowed size");
  }
}

/**
 * Where ciphertext lives. The metadata database never holds blob bytes; a
 * store implementation only needs streaming put/get/remove of opaque keys.
 */
export interface BlobStore {
  /** Streams a blob in, enforcing maxBytes; resolves to the byte count. */
  put(key: string, source: Readable, maxBytes: number): Promise<number>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
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

  async get(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  async remove(key: string): Promise<void> {
    if (existsSync(this.path(key))) {
      unlinkSync(this.path(key));
    }
  }
}
