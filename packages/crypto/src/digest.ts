import { sodium } from "./sodium.js";
import { toB64 } from "./encoding.js";

/**
 * A digest of a file's contents, taken on the device that holds it.
 *
 * Authenticated encryption already proves that what came back from the
 * server is what was sent to it. It cannot prove that what was sent is what
 * the file contained: a fault on the way in encrypts the wrong bytes
 * faithfully, and every check below that point passes. So the digest is
 * taken at the source, before any encryption, and checked after decryption.
 * It closes the half of the path the encryption cannot see.
 *
 * BLAKE2b-256, which libsodium provides, is fast enough to ride along with
 * the encryption rather than needing a second pass over the file.
 */

const DIGEST_BYTES = 32;

/** Digest of bytes already in hand. */
export function contentDigest(bytes: Uint8Array): string {
  return toB64(sodium().crypto_generichash(DIGEST_BYTES, bytes, null));
}

export interface Digester {
  /** Feed the next piece, in order. */
  update(bytes: Uint8Array): void;
  /** The digest of everything fed so far. Call once. */
  final(): string;
}

/**
 * A digest built piece by piece, for a file read in slices because it is too
 * large to hold at once. The pieces must arrive in order; that is the same
 * order the upload encrypts them in, so one pass serves both.
 */
export function createDigester(): Digester {
  const s = sodium();
  const state = s.crypto_generichash_init(null, DIGEST_BYTES);
  let done = false;
  return {
    update(bytes: Uint8Array) {
      if (done) {
        throw new Error("this digest is already final");
      }
      s.crypto_generichash_update(state, bytes);
    },
    final() {
      if (done) {
        throw new Error("this digest is already final");
      }
      done = true;
      return toB64(s.crypto_generichash_final(state, DIGEST_BYTES));
    },
  };
}

/**
 * Whether bytes match a digest recorded earlier. An absent digest is not a
 * failure: files stored before digests existed carry none, and refusing them
 * would strand data that is almost certainly fine.
 */
export function digestMatches(bytes: Uint8Array, expected: string | undefined): boolean {
  return expected === undefined || contentDigest(bytes) === expected;
}
