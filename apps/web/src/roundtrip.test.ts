import { beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  chunkedEncrypt,
  contentDigest,
  createDigester,
  decryptBytes,
  digestMatches,
  chunkedDecrypt,
  encryptBytes,
  generateKey,
} from "@engramer/crypto";
import { fileBytes } from "./native";

/**
 * Bytes in must equal bytes out. Every path that carries file content is
 * held to that here, with content chosen to break the things that have
 * broken before: a watched folder stored files as the text
 * "37,80,68,70,..." because a Blob accepts an array and stringifies it, and
 * nothing above the encryption could tell.
 *
 * The encryption cannot catch that class of fault. It faithfully encrypts
 * whatever it is handed, so a test that only decrypts what it encrypted
 * proves nothing about what was handed over. These start from the bytes.
 */
describe("file content survives every path byte for byte", () => {
  beforeAll(async () => {
    await ready();
  });

  /** Everything that tends to break a byte pipeline, in one buffer. */
  const adversarial = (): Uint8Array => {
    const parts: number[] = [];
    for (let i = 0; i < 256; i++) parts.push(i); // every byte value
    parts.push(0x00, 0x00, 0x00); // nulls, which truncate C-style handling
    parts.push(0xff, 0xfe); // a UTF-16 byte order mark
    parts.push(0xc3, 0x28); // invalid UTF-8: would become a replacement char
    parts.push(0xed, 0xa0, 0x80); // a lone surrogate, unrepresentable in UTF-8
    parts.push(0x25, 0x50, 0x44, 0x46); // "%PDF"
    for (let i = 0; i < 5000; i++) parts.push((i * 31 + 7) % 256);
    return Uint8Array.from(parts);
  };

  it("survives a small-file upload and download", () => {
    const key = generateKey();
    const original = adversarial();
    const back = decryptBytes(encryptBytes(original, key), key);
    expect(back).toEqual(original);
    expect(digestMatches(back, contentDigest(original))).toBe(true);
  });

  it("survives the chunked path used for media", () => {
    const key = generateKey();
    const original = adversarial();
    const back = chunkedDecrypt(chunkedEncrypt(original, key), key);
    expect(back).toEqual(original);
    expect(digestMatches(back, contentDigest(original))).toBe(true);
  });

  it("digests a sliced read exactly as the whole file, which large uploads rely on", () => {
    const original = adversarial();
    const digester = createDigester();
    for (let at = 0; at < original.length; at += 1000) {
      digester.update(original.subarray(at, Math.min(at + 1000, original.length)));
    }
    expect(digester.final()).toBe(contentDigest(original));
  });

  it("carries bytes from the desktop shell without changing them", () => {
    // The shell hands over an array of byte values, not a buffer.
    const original = adversarial();
    const asShellSendsIt = Array.from(original);
    const carried = fileBytes(asShellSendsIt);
    expect(carried).toEqual(original);
    expect(contentDigest(carried)).toBe(contentDigest(original));
  });

  it("catches the corruption that shipped, rather than trusting the size", () => {
    const original = adversarial();
    // What the old code stored: the array stringified by a Blob.
    const corrupted = new TextEncoder().encode(Array.from(original).join(","));
    expect(corrupted.length).toBeGreaterThan(original.length * 2);
    expect(digestMatches(corrupted, contentDigest(original))).toBe(false);
  });

  it("catches a single flipped byte, which a size check never would", () => {
    const original = adversarial();
    const flipped = original.slice();
    flipped[4000] = (flipped[4000]! + 1) % 256;
    expect(flipped.length).toBe(original.length);
    expect(digestMatches(flipped, contentDigest(original))).toBe(false);
  });

  it("catches truncation, which a decrypt alone might not", () => {
    const original = adversarial();
    expect(digestMatches(original.slice(0, original.length - 1), contentDigest(original))).toBe(false);
  });
});
