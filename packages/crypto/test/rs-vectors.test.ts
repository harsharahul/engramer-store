import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  toB64,
  fromB64,
  contentDigest,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  loginKeyDigest,
  deriveUnlockKey,
  secretBoxOpen,
  openSealed,
  decryptBytes,
  chunkedDecrypt,
  chunkedCiphertextSize,
  streamCiphertextSize,
  decryptFileMetadata,
} from "../src/index.js";

/**
 * Consumes the vectors the Rust crate generated: its deterministic values
 * must reproduce here byte for byte, and its sealed artifacts must open.
 * The mirror of crates/engram-core/tests/ts_vectors.rs; together they hold
 * both implementations to the same bytes in both directions.
 */

const rsDir = join(dirname(fileURLToPath(import.meta.url)), "vectors", "rs");
const tsDir = join(dirname(fileURLToPath(import.meta.url)), "vectors", "ts");
const vectors = JSON.parse(readFileSync(join(rsDir, "vectors.json"), "utf8"));
const sealed = JSON.parse(readFileSync(join(rsDir, "sealed.json"), "utf8"));

const fromHex = (hex: string) =>
  new Uint8Array([...Array(hex.length / 2)].map((_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)));

const patternBytes = (n: number, mul: number, add: number) =>
  new Uint8Array([...Array(n)].map((_, i) => (i * mul + add) % 256));

beforeAll(async () => {
  await ready();
});

describe("rust vectors", () => {
  it("agrees on base64url", () => {
    for (const c of vectors.b64url) {
      expect(toB64(fromHex(c.hexIn))).toBe(c.out);
      expect(fromB64(c.out)).toEqual(fromHex(c.hexIn));
    }
  });

  it("agrees on digests", () => {
    for (const c of vectors.digest) {
      if (c.incremental) {
        continue; // incremental equivalence is asserted in the rust consumer
      }
      expect(contentDigest(fromHex(c.hexIn))).toBe(c.out);
    }
  });

  it("agrees on argon2id keks", () => {
    for (const c of vectors.argon2id) {
      const { kek } = deriveKeyEncryptionKey(c.password, {
        salt: c.salt,
        opsLimit: c.opsLimit,
        memLimit: c.memLimit,
      });
      expect(toB64(kek)).toBe(c.kek);
    }
  });

  it("agrees on the kdf chain", () => {
    const kek = fromB64(vectors.kdf.kek);
    const loginKey = deriveLoginKey(kek);
    expect(loginKey).toBe(vectors.kdf.loginKey);
    expect(loginKeyDigest(loginKey)).toBe(vectors.kdf.loginKeyDigest);
    expect(toB64(deriveUnlockKey(fromHex(vectors.kdf.unlockSecretHex)))).toBe(vectors.kdf.unlockKey);
  });

  it("agrees on size arithmetic", () => {
    for (const c of vectors.sizes) {
      expect(chunkedCiphertextSize(c.plain)).toBe(c.chunked);
      expect(streamCiphertextSize(c.plain)).toBe(c.stream);
    }
  });

  it("opens a rust secretbox", () => {
    const c = vectors.secretbox;
    expect(secretBoxOpen(c.box, fromHex(c.keyHex))).toEqual(fromHex(c.plainHex));
  });

  it("opens the rust chunked media blob", () => {
    const c = vectors.egc1;
    const blob = new Uint8Array(readFileSync(join(rsDir, "egc1.bin")));
    expect(chunkedDecrypt(blob, fromHex(c.keyHex))).toEqual(
      patternBytes(c.plainLen, c.plainMul, c.plainAdd),
    );
  });

  it("opens the rust secretstream blob and rejects truncation", () => {
    const c = sealed.stream;
    const blob = new Uint8Array(readFileSync(join(rsDir, "stream.bin")));
    expect(decryptBytes(blob, fromHex(sealed.keyHex))).toEqual(
      patternBytes(c.plainLen, c.plainMul, c.plainAdd),
    );
    expect(() => decryptBytes(blob.slice(0, -10), fromHex(sealed.keyHex))).toThrow();
  });

  it("opens a box rust sealed to the committed keypair", () => {
    const ts = JSON.parse(readFileSync(join(tsDir, "sealed.json"), "utf8"));
    const c = sealed.sealedbox;
    expect(c.toPublicKey).toBe(ts.sealedbox.publicKey);
    const opened = openSealed(c.sealed, ts.sealedbox.publicKey, fromB64(ts.sealedbox.privateKey));
    expect(new TextDecoder().decode(opened)).toBe(c.message);
  });

  it("opens rust file metadata, sourceId included", () => {
    const meta = decryptFileMetadata(sealed.metadata.box, fromHex(sealed.keyHex));
    expect(meta.name).toBe("rust née fixture.pdf");
    expect(meta.tags).toEqual(["album:fixtures", "rusty"]);
    expect((meta as Record<string, unknown>).sourceId).toBe("asset-0001");
  });
});
