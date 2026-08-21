import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, ready, toB64 } from "@engramer/crypto";
import { decodeSessionKey, openTabSession, parseStoredTabSession, sealTabSession } from "./tabsession";

function fakeSession() {
  return {
    email: "tab@example.com",
    token: "jwt-token-1",
    masterKey: generateKey(),
    privateKey: generateKey(),
    publicKey: "pubkey-b64",
  };
}

beforeAll(async () => {
  await ready();
});

describe("tab session record", () => {
  it("round-trips a session through seal and open", () => {
    const sessionKey = generateKey();
    const session = fakeSession();
    const stored = sealTabSession(session, "skid-1", sessionKey);
    const opened = openTabSession(stored, sessionKey);
    expect(opened.email).toBe(session.email);
    expect(opened.token).toBe(session.token);
    expect(opened.publicKey).toBe(session.publicKey);
    expect(Buffer.from(opened.masterKey).equals(Buffer.from(session.masterKey))).toBe(true);
    expect(Buffer.from(opened.privateKey).equals(Buffer.from(session.privateKey))).toBe(true);
  });

  it("holds no key in the clear; only the token that fetches the session key", () => {
    const session = fakeSession();
    const stored = sealTabSession(session, "skid-1", generateKey());
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(toB64(session.masterKey));
    expect(serialized).not.toContain(toB64(session.privateKey));
    expect(serialized).not.toContain(Buffer.from(session.masterKey).toString("base64"));
    expect(stored.token).toBe(session.token);
  });

  it("rejects the wrong session key and a tampered record", () => {
    const sessionKey = generateKey();
    const stored = sealTabSession(fakeSession(), "skid-1", sessionKey);
    expect(() => openTabSession(stored, generateKey())).toThrow();
    const tampered = {
      ...stored,
      wrappedMasterKey: {
        ...stored.wrappedMasterKey,
        ciphertext: `${stored.wrappedMasterKey.ciphertext.slice(0, -4)}AAAA`,
      },
    };
    expect(() => openTabSession(tampered, sessionKey)).toThrow();
  });

  it("parses only current-format records and discards the pre-wrap one", () => {
    const stored = sealTabSession(fakeSession(), "skid-1", generateKey());
    expect(parseStoredTabSession(JSON.stringify(stored))?.skid).toBe("skid-1");
    // The format that held the keys in the clear is never honored.
    const legacy = JSON.stringify({
      email: "tab@example.com",
      token: "jwt",
      masterKey: toB64(generateKey()),
      privateKey: toB64(generateKey()),
      publicKey: "pk",
    });
    expect(parseStoredTabSession(legacy)).toBeNull();
    expect(parseStoredTabSession(null)).toBeNull();
    expect(parseStoredTabSession("not json")).toBeNull();
    expect(parseStoredTabSession(JSON.stringify({ v: 2, email: "x" }))).toBeNull();
  });

  it("accepts a 32-byte session key and nothing else", () => {
    expect(decodeSessionKey(toB64(generateKey())).length).toBe(32);
    expect(() => decodeSessionKey(toB64(new Uint8Array(16)))).toThrow();
  });
});
