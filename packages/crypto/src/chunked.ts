import { sodium } from "./sodium.js";
import { decryptBytes } from "./stream.js";

/**
 * Random-access media format: independently sealed chunks instead of a
 * sequential stream. Each chunk's nonce derives from the authenticated
 * header (which carries a per-encryption random salt) and the chunk index,
 * so any chunk decrypts alone, a chunk presented at the wrong position
 * fails authentication, and re-encrypting under the same file key can
 * never reuse a nonce. Built for video and audio, where players ask for
 * byte ranges and expect answers in constant time.
 *
 * Layout: magic "EGC1" (4) | salt (16) | plaintext size LE64 (8) | chunks.
 * Chunk i seals plaintext [i*CHUNK, ...) and is CHUNK+16 bytes except the
 * last. The sequential stream format remains the default for everything
 * that is not media.
 */

export const CHUNKED_CHUNK_SIZE = 4 * 1024 * 1024;

const MAGIC = new Uint8Array([0x45, 0x47, 0x43, 0x31]); // "EGC1"
const SALT_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + 8;
const TAG_BYTES = 16; // crypto_secretbox MAC

export interface ChunkedHeader {
  plainSize: number;
  headerBytes: Uint8Array;
}

export interface ChunkSpan {
  firstChunk: number;
  lastChunk: number;
  /** Ciphertext byte offsets of the span, inclusive, header included. */
  ciphertextStart: number;
  ciphertextEnd: number;
  /** Plaintext offset the span's first byte corresponds to. */
  plainStart: number;
}

function chunkCount(plainSize: number): number {
  return plainSize === 0 ? 1 : Math.ceil(plainSize / CHUNKED_CHUNK_SIZE);
}

export function chunkedCiphertextSize(plainSize: number): number {
  return HEADER_BYTES + plainSize + chunkCount(plainSize) * TAG_BYTES;
}

function chunkNonce(headerBytes: Uint8Array, index: number): Uint8Array {
  const s = sodium();
  const input = new Uint8Array(headerBytes.length + 8);
  input.set(headerBytes, 0);
  new DataView(input.buffer).setBigUint64(headerBytes.length, BigInt(index), true);
  return s.crypto_generichash(24, input, null);
}

function buildHeader(plainSize: number): Uint8Array {
  const s = sodium();
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header.set(s.randombytes_buf(SALT_BYTES), MAGIC.length);
  new DataView(header.buffer).setBigUint64(MAGIC.length + SALT_BYTES, BigInt(plainSize), true);
  return header;
}

export function isChunkedFormat(ciphertext: Uint8Array): boolean {
  if (ciphertext.length < HEADER_BYTES) {
    return false;
  }
  return MAGIC.every((byte, i) => ciphertext[i] === byte);
}

export function readChunkedHeader(ciphertext: Uint8Array): ChunkedHeader {
  if (!isChunkedFormat(ciphertext)) {
    throw new Error("not a chunked blob");
  }
  const headerBytes = ciphertext.slice(0, HEADER_BYTES);
  const plainSize = Number(
    new DataView(headerBytes.buffer, headerBytes.byteOffset).getBigUint64(
      MAGIC.length + SALT_BYTES,
      true,
    ),
  );
  return { plainSize, headerBytes };
}

/** Encrypts one chunk; exposed so uploaders can stream without buffering. */
export class ChunkedEncryptor {
  readonly header: Uint8Array;

  constructor(
    private readonly key: Uint8Array,
    plainSize: number,
  ) {
    this.header = buildHeader(plainSize);
  }

  seal(chunkIndex: number, plainChunk: Uint8Array): Uint8Array {
    const s = sodium();
    return s.crypto_secretbox_easy(plainChunk, chunkNonce(this.header, chunkIndex), this.key);
  }
}

export function chunkedEncrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const encryptor = new ChunkedEncryptor(key, plaintext.length);
  const parts: Uint8Array[] = [encryptor.header];
  const count = chunkCount(plaintext.length);
  for (let i = 0; i < count; i++) {
    parts.push(
      encryptor.seal(
        i,
        plaintext.subarray(i * CHUNKED_CHUNK_SIZE, Math.min((i + 1) * CHUNKED_CHUNK_SIZE, plaintext.length)),
      ),
    );
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The chunk span covering a plaintext byte range (inclusive bounds). */
export function chunkSpanForRange(header: ChunkedHeader, start: number, end: number): ChunkSpan {
  const lastByte = Math.min(end, Math.max(0, header.plainSize - 1));
  const firstChunk = Math.floor(start / CHUNKED_CHUNK_SIZE);
  const lastChunk = Math.floor(lastByte / CHUNKED_CHUNK_SIZE);
  const sealedChunk = CHUNKED_CHUNK_SIZE + TAG_BYTES;
  const total = chunkedCiphertextSize(header.plainSize);
  return {
    firstChunk,
    lastChunk,
    ciphertextStart: HEADER_BYTES + firstChunk * sealedChunk,
    ciphertextEnd: Math.min(HEADER_BYTES + (lastChunk + 1) * sealedChunk, total) - 1,
    plainStart: firstChunk * CHUNKED_CHUNK_SIZE,
  };
}

/** Decrypts the ciphertext of a chunk span fetched via a ranged read. */
export function decryptChunkRange(
  header: ChunkedHeader,
  key: Uint8Array,
  ciphertext: Uint8Array,
  span: ChunkSpan,
): Uint8Array {
  const s = sodium();
  const sealedChunk = CHUNKED_CHUNK_SIZE + TAG_BYTES;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let index = span.firstChunk; index <= span.lastChunk; index++) {
    const take = Math.min(sealedChunk, ciphertext.length - offset);
    const opened = s.crypto_secretbox_open_easy(
      ciphertext.subarray(offset, offset + take),
      chunkNonce(header.headerBytes, index),
      key,
    );
    parts.push(opened);
    offset += take;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function chunkedDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const header = readChunkedHeader(ciphertext);
  if (ciphertext.length !== chunkedCiphertextSize(header.plainSize)) {
    throw new Error("chunked blob size mismatch");
  }
  const span = chunkSpanForRange(header, 0, Math.max(0, header.plainSize - 1));
  return decryptChunkRange(header, key, ciphertext.subarray(span.ciphertextStart), span);
}

/** Decrypts content of either format; the chunked magic self-describes. */
export function decryptContent(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  return isChunkedFormat(ciphertext) ? chunkedDecrypt(ciphertext, key) : decryptBytes(ciphertext, key);
}
