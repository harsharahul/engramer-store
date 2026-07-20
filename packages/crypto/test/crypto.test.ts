import { beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateKey,
  secretBoxSeal,
  secretBoxOpen,
  generateKeyPair,
  sealToPublicKey,
  openSealed,
  generateAccountKeys,
  unlockWithPassword,
  unlockWithRecoveryKey,
  rewrapMasterKey,
  loginKeyDigest,
  encryptBytes,
  decryptBytes,
  encryptFileMetadata,
  decryptFileMetadata,
  utf8Encode,
  utf8Decode,
  fromB64,
  STREAM_CHUNK_SIZE,
  type AccountKeys,
} from "../src/index.js";

beforeAll(async () => {
  await ready();
});

/**
 * Compares byte arrays without handing millions of elements to the deep-equal
 * matcher, which builds a per-element diff and exhausts the heap on multi-chunk
 * files. This is a memcmp, and only a mismatch pays for a detailed report.
 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (!a.equals(b)) {
    const index = actual.findIndex((byte, i) => byte !== expected[i]);
    throw new Error(
      `byte arrays differ at index ${index}: ${actual[index]} !== ${expected[index]}`,
    );
  }
}

describe("secretbox", () => {
  it("round-trips data", () => {
    const key = generateKey();
    const plaintext = utf8Encode("hello engramer");
    const box = secretBoxSeal(plaintext, key);
    expect(utf8Decode(secretBoxOpen(box, key))).toBe("hello engramer");
  });

  it("rejects tampered ciphertext", () => {
    const key = generateKey();
    const box = secretBoxSeal(utf8Encode("data"), key);
    const bytes = fromB64(box.ciphertext);
    bytes[0]! ^= 0xff;
    const tampered = { ...box, ciphertext: Buffer.from(bytes).toString("base64url") };
    expect(() => secretBoxOpen(tampered, key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const box = secretBoxSeal(utf8Encode("data"), generateKey());
    expect(() => secretBoxOpen(box, generateKey())).toThrow();
  });
});

describe("account key hierarchy", () => {
  let account: AccountKeys;
  const password = "correct horse battery staple";

  beforeAll(() => {
    account = generateAccountKeys(password);
  });

  it("never exposes the master key in key attributes", () => {
    const json = JSON.stringify(account.keyAttributes);
    expect(json).not.toContain(Buffer.from(account.masterKey).toString("base64url"));
  });

  it("unlocks with the correct password", () => {
    const unlocked = unlockWithPassword(password, account.keyAttributes);
    expect(unlocked.masterKey).toEqual(account.masterKey);
    expect(unlocked.privateKey).toEqual(account.privateKey);
    expect(unlocked.loginKey).toBe(account.loginKey);
  });

  it("rejects a wrong password", () => {
    expect(() => unlockWithPassword("wrong password", account.keyAttributes)).toThrow();
  });

  it("recovers the master key with the recovery key", () => {
    const masterKey = unlockWithRecoveryKey(account.recoveryKeyHex, account.keyAttributes);
    expect(masterKey).toEqual(account.masterKey);
  });

  it("re-wraps the master key on password change without touching data keys", () => {
    const { keyAttributes, loginKey } = rewrapMasterKey(
      "a brand new password",
      account.masterKey,
      account.keyAttributes,
    );
    expect(loginKey).not.toBe(account.loginKey);
    const unlocked = unlockWithPassword("a brand new password", keyAttributes);
    expect(unlocked.masterKey).toEqual(account.masterKey);
    expect(() => unlockWithPassword(password, keyAttributes)).toThrow();
  });

  // Guards against a future change quietly weakening password derivation.
  // The floor is OWASP's Argon2id recommendation (19 MiB, 2 passes); the
  // default is libsodium's moderate profile, far above it.
  it("derives keys with Argon2id parameters at or above the security floor", () => {
    const { kdf } = account.keyAttributes;
    expect(kdf.memLimit).toBeGreaterThanOrEqual(19 * 1024 * 1024);
    expect(kdf.opsLimit).toBeGreaterThanOrEqual(2);
    expect(kdf.salt.length).toBeGreaterThan(0);
  });

  it("derives a stable login key digest that differs from the login key", () => {
    const digest = loginKeyDigest(account.loginKey);
    expect(digest).toBe(loginKeyDigest(account.loginKey));
    expect(digest).not.toBe(account.loginKey);
  });
});

describe("streaming file encryption", () => {
  it("round-trips an empty file", () => {
    const key = generateKey();
    expectBytesEqual(decryptBytes(encryptBytes(new Uint8Array(0), key), key), new Uint8Array(0));
  });

  it("round-trips a small file", () => {
    const key = generateKey();
    const data = crypto.getRandomValues(new Uint8Array(1024));
    expectBytesEqual(decryptBytes(encryptBytes(data, key), key), data);
  });

  it("round-trips a multi-chunk file", () => {
    const key = generateKey();
    const data = new Uint8Array(STREAM_CHUNK_SIZE * 2 + 12345);
    for (let i = 0; i < data.length; i += 65536) {
      crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
    }
    expectBytesEqual(decryptBytes(encryptBytes(data, key), key), data);
  });

  it("rejects a flipped bit anywhere in the blob", () => {
    const key = generateKey();
    const blob = encryptBytes(crypto.getRandomValues(new Uint8Array(4096)), key);
    blob[blob.length - 1]! ^= 0x01;
    expect(() => decryptBytes(blob, key)).toThrow();
  });

  it("rejects a truncated blob", () => {
    const key = generateKey();
    const data = new Uint8Array(STREAM_CHUNK_SIZE + 100);
    const blob = encryptBytes(data, key);
    const truncated = blob.subarray(0, blob.length - 50);
    expect(() => decryptBytes(truncated, key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const blob = encryptBytes(crypto.getRandomValues(new Uint8Array(64)), generateKey());
    expect(() => decryptBytes(blob, generateKey())).toThrow();
  });
});

describe("file metadata", () => {
  it("round-trips and stays opaque without the key", () => {
    const fileKey = generateKey();
    const meta = {
      name: "vacation.jpg",
      mime: "image/jpeg",
      size: 123456,
      mtime: 1700000000000,
      width: 4032,
      height: 3024,
    };
    const box = encryptFileMetadata(meta, fileKey);
    expect(decryptFileMetadata(box, fileKey)).toEqual(meta);
    expect(box.ciphertext).not.toContain("vacation");
    expect(() => decryptFileMetadata(box, generateKey())).toThrow();
  });
});

describe("sealed boxes for sharing", () => {
  it("seals to a public key and opens with the private key", () => {
    const recipient = generateKeyPair();
    const fileKey = generateKey();
    const sealed = sealToPublicKey(fileKey, recipient.publicKey);
    const opened = openSealed(sealed, recipient.publicKey, recipient.privateKey);
    expectBytesEqual(opened, fileKey);
  });

  it("cannot be opened by a different key pair", () => {
    const recipient = generateKeyPair();
    const other = generateKeyPair();
    const sealed = sealToPublicKey(generateKey(), recipient.publicKey);
    expect(() => openSealed(sealed, other.publicKey, other.privateKey)).toThrow();
  });
});
