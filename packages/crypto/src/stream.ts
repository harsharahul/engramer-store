import { sodium } from "./sodium.js";

/**
 * File content encryption: XChaCha20-Poly1305 secretstream over fixed 4 MiB
 * plaintext chunks. The wire format is the stream header followed by the
 * encrypted chunks, so a blob decrypts sequentially with constant memory and
 * any truncation, reordering, or bit flip fails authentication.
 */
export const STREAM_CHUNK_SIZE = 4 * 1024 * 1024;

export function streamHeaderBytes(): number {
  return sodium().crypto_secretstream_xchacha20poly1305_HEADERBYTES;
}

export function streamOverheadBytes(): number {
  return sodium().crypto_secretstream_xchacha20poly1305_ABYTES;
}

/** Ciphertext chunk length for a plaintext chunk of the given length. */
export function encryptedChunkSize(plainChunkSize: number): number {
  return plainChunkSize + streamOverheadBytes();
}

/** Exact stream-format ciphertext size for a plaintext of the given length,
 * so an uploader can declare the total before encrypting a single chunk. */
export function streamCiphertextSize(plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / STREAM_CHUNK_SIZE));
  return streamHeaderBytes() + plainSize + chunks * streamOverheadBytes();
}

export class StreamEncryptor {
  readonly header: Uint8Array;
  private readonly state: unknown;

  constructor(key: Uint8Array) {
    const s = sodium();
    const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
    this.state = state;
    this.header = header;
  }

  push(chunk: Uint8Array, final: boolean): Uint8Array {
    const s = sodium();
    const tag = final
      ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    return s.crypto_secretstream_xchacha20poly1305_push(
      this.state as never,
      chunk,
      null,
      tag,
    );
  }
}

export class StreamDecryptor {
  private readonly state: unknown;

  constructor(key: Uint8Array, header: Uint8Array) {
    const s = sodium();
    this.state = s.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  }

  pull(ciphertextChunk: Uint8Array): { message: Uint8Array; final: boolean } {
    const s = sodium();
    const result = s.crypto_secretstream_xchacha20poly1305_pull(
      this.state as never,
      ciphertextChunk,
      null,
    );
    if (!result) {
      throw new Error("stream chunk failed authentication");
    }
    return {
      message: result.message,
      final: result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    };
  }
}

/** Encrypts a whole buffer into header-prefixed chunked stream format. */
export function encryptBytes(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const encryptor = new StreamEncryptor(key);
  const parts: Uint8Array[] = [encryptor.header];
  let offset = 0;
  do {
    const end = Math.min(offset + STREAM_CHUNK_SIZE, plaintext.length);
    const final = end === plaintext.length;
    parts.push(encryptor.push(plaintext.subarray(offset, end), final));
    offset = end;
  } while (offset < plaintext.length);
  return concat(parts);
}

/** Decrypts a header-prefixed chunked stream buffer. Throws on any tampering. */
export function decryptBytes(data: Uint8Array, key: Uint8Array): Uint8Array {
  const headerBytes = streamHeaderBytes();
  if (data.length < headerBytes) {
    throw new Error("encrypted blob too short");
  }
  const decryptor = new StreamDecryptor(key, data.subarray(0, headerBytes));
  const chunkBytes = encryptedChunkSize(STREAM_CHUNK_SIZE);
  const parts: Uint8Array[] = [];
  let offset = headerBytes;
  let final = false;
  do {
    const end = Math.min(offset + chunkBytes, data.length);
    const result = decryptor.pull(data.subarray(offset, end));
    parts.push(result.message);
    final = result.final;
    offset = end;
  } while (offset < data.length);
  if (!final) {
    throw new Error("encrypted blob is truncated");
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
