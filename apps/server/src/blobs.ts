import { createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type BlobKind = "data" | "thumb";

export function blobPath(blobDir: string, fileId: string, kind: BlobKind): string {
  return join(blobDir, kind === "data" ? fileId : `${fileId}.thumb`);
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the allowed size");
  }
}

/**
 * Streams a request body to disk through a temp file, counting bytes and
 * aborting past maxBytes so a client cannot blow through its quota mid-upload.
 * Returns the number of bytes written.
 */
export async function writeBlobStream(
  source: Readable,
  destination: string,
  maxBytes: number,
): Promise<number> {
  const tmp = `${destination}.upload-${process.pid}-${Date.now()}`;
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new BlobTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, destination);
    return written;
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function deleteBlobIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function blobSize(path: string): number {
  return statSync(path).size;
}
