import { describe, expect, it, beforeAll } from "vitest";
import { ready, contentDigest, createDigester, digestMatches } from "../src/index.js";

/**
 * The digest exists to catch bytes going wrong on the way in, where the
 * encryption cannot see. These tests hold it to that: same bytes agree,
 * different bytes disagree, and a file read in slices digests exactly as it
 * would whole, because large uploads are hashed piece by piece.
 */
describe("content digest", () => {
  beforeAll(async () => {
    await ready();
  });

  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);

  it("agrees with itself and disagrees with anything else", () => {
    const a = bytes(4096);
    const b = bytes(4096);
    b[2048] = (b[2048]! + 1) % 256;
    expect(contentDigest(a)).toBe(contentDigest(a.slice()));
    expect(contentDigest(a)).not.toBe(contentDigest(b));
  });

  it("notices a file that changed length, not only content", () => {
    const a = bytes(1000);
    expect(contentDigest(a)).not.toBe(contentDigest(a.slice(0, 999)));
  });

  it("digests a file read in slices exactly as it digests it whole", () => {
    const whole = bytes(100_000);
    for (const slice of [1, 997, 4096, 65_536]) {
      const digester = createDigester();
      for (let at = 0; at < whole.length; at += slice) {
        digester.update(whole.subarray(at, Math.min(at + slice, whole.length)));
      }
      expect(digester.final()).toBe(contentDigest(whole));
    }
  });

  it("catches the corruption that actually happened: bytes stringified", () => {
    // A watched folder stored files as the text "37,80,68,70,..." because a
    // Blob accepts an array and stringifies it. Same file, different bytes.
    const file = bytes(2048);
    const stringified = new TextEncoder().encode(Array.from(file).join(","));
    expect(contentDigest(stringified)).not.toBe(contentDigest(file));
    expect(digestMatches(stringified, contentDigest(file))).toBe(false);
  });

  it("treats a missing digest as unverified rather than failed", () => {
    // Files stored before digests existed carry none; refusing them would
    // strand data that is almost certainly fine.
    expect(digestMatches(bytes(10), undefined)).toBe(true);
    expect(digestMatches(bytes(10), contentDigest(bytes(10)))).toBe(true);
  });

  it("refuses to be used twice", () => {
    const digester = createDigester();
    digester.update(bytes(10));
    digester.final();
    expect(() => digester.final()).toThrow();
    expect(() => digester.update(bytes(10))).toThrow();
  });
});
