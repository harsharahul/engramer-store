import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, publicKeyFingerprint, ready } from "../src/index.js";

beforeAll(async () => {
  await ready();
});

describe("public key fingerprint", () => {
  it("is eight groups of four hex digits, stable for the same key", () => {
    const { publicKey } = generateKeyPair();
    const fingerprint = publicKeyFingerprint(publicKey);
    expect(fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(publicKeyFingerprint(publicKey)).toBe(fingerprint);
  });

  it("differs between keys", () => {
    expect(publicKeyFingerprint(generateKeyPair().publicKey)).not.toBe(
      publicKeyFingerprint(generateKeyPair().publicKey),
    );
  });

  it("refuses a key that is not base64", () => {
    expect(() => publicKeyFingerprint("not base64!!")).toThrow();
  });
});
