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
  StreamEncryptor,
  streamCiphertextSize,
  CHUNKED_CHUNK_SIZE,
  chunkedEncrypt,
  chunkedDecrypt,
  chunkedCiphertextSize,
  isChunkedFormat,
  readChunkedHeader,
  chunkSpanForRange,
  decryptChunkRange,
  decryptContent,
  streamPlaintextSize,
  protectShareKey,
  deriveShareAccess,
  openShareKey,
  shareAccessDigest,
  deriveKeyEncryptionKey,
  deriveUnlockKey,
  WeakKdfError,
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

describe("re-encryption freshness", () => {
  // Editing means re-encrypting the same logical document over and over.
  // Nextcloud's E2EE was broken (EuroS&P 2024) partly because a modified file
  // was re-encrypted under the same key AND the same nonce. Our secretstream
  // draws a fresh random header per encryption; this pins that property.
  it("never repeats the stream header when the same file is saved twice", () => {
    const fileKey = generateKey();
    const content = utf8Encode("the same document, saved twice");
    const first = encryptBytes(content, fileKey);
    const second = encryptBytes(content, fileKey);
    // Header (nonce material) differs, and so does every ciphertext byte run.
    expect(Buffer.from(first.slice(0, 24)).equals(Buffer.from(second.slice(0, 24)))).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    // Both still decrypt to the same plaintext.
    expectBytesEqual(decryptBytes(first, fileKey), content);
    expectBytesEqual(decryptBytes(second, fileKey), content);
  });
});

describe("password protected share links", () => {
  it("round-trips the file key through the password", () => {
    const fileKey = generateKey();
    const protection = protectShareKey(fileKey, "swordfish festival");
    const access = deriveShareAccess("swordfish festival", protection.kdf);
    expect(access.accessKey).toBe(protection.accessKey);
    expect(shareAccessDigest(access.accessKey)).toBe(protection.accessKeyDigest);
    expectBytesEqual(openShareKey(protection.wrappedKey, access), fileKey);
  });

  it("fails closed on a wrong password", () => {
    const protection = protectShareKey(generateKey(), "right password");
    const access = deriveShareAccess("wrong password", protection.kdf);
    expect(shareAccessDigest(access.accessKey)).not.toBe(protection.accessKeyDigest);
    expect(() => openShareKey(protection.wrappedKey, access)).toThrow();
  });

  it("keeps the access and wrap subkeys independent", () => {
    const fileKey = generateKey();
    const protection = protectShareKey(fileKey, "domain separation");
    const access = deriveShareAccess("domain separation", protection.kdf);
    // Knowing the access key (what the server sees) must not open the wrap.
    expect(() =>
      openShareKey(protection.wrappedKey, { accessKey: access.accessKey, wrapKey: fromB64(access.accessKey) }),
    ).toThrow();
  });
});

describe("key derivation floor", () => {
  it("refuses password-hashing parameters below the OWASP floor", async () => {
    await ready();
    const account = generateAccountKeys("a floor test password");
    // A hostile server could otherwise answer the pre-login request with
    // trivial parameters, watch a cheap derivation, and crack offline.
    expect(() =>
      deriveKeyEncryptionKey("a floor test password", {
        ...account.keyAttributes.kdf,
        opsLimit: 1,
        memLimit: 8192,
      }),
    ).toThrow(WeakKdfError);
    // The real parameters still work.
    expect(() =>
      deriveKeyEncryptionKey("a floor test password", account.keyAttributes.kdf),
    ).not.toThrow();
  });
});

describe("device unlock key derivation", () => {
  beforeAll(async () => {
    await ready();
  });

  it("derives a stable 32-byte key from a PRF secret", () => {
    const secret = generateKey();
    const first = deriveUnlockKey(secret);
    const second = deriveUnlockKey(secret);
    expect(first.length).toBe(32);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(secret))).toBe(false);
  });

  it("derives distinct keys from distinct secrets", () => {
    const a = deriveUnlockKey(generateKey());
    const b = deriveUnlockKey(generateKey());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("accepts secrets of any length", () => {
    const long = new Uint8Array(64).fill(7);
    const key = deriveUnlockKey(long);
    expect(key.length).toBe(32);
  });

  it("wraps and unwraps a master key with the derived key", () => {
    const secret = generateKey();
    const masterKey = generateKey();
    const wrapped = secretBoxSeal(masterKey, deriveUnlockKey(secret));
    const opened = secretBoxOpen(wrapped, deriveUnlockKey(secret));
    expect(Buffer.from(opened).equals(Buffer.from(masterKey))).toBe(true);
    expect(() => secretBoxOpen(wrapped, deriveUnlockKey(generateKey()))).toThrow();
  });
});

describe("stream size accounting and grouped encryption", () => {
  beforeAll(async () => {
    await ready();
  });

  it("predicts the exact ciphertext size for any plaintext length", () => {
    const sizes = [0, 1, 17, STREAM_CHUNK_SIZE - 1, STREAM_CHUNK_SIZE, STREAM_CHUNK_SIZE + 1, Math.floor(2.5 * STREAM_CHUNK_SIZE)];
    const key = generateKey();
    for (const size of sizes) {
      const plaintext = new Uint8Array(size).fill(3);
      expect(streamCiphertextSize(size)).toBe(encryptBytes(plaintext, key).length);
    }
  });

  it("produces an identical stream when chunks are pushed in grouped parts", () => {
    const key = generateKey();
    const plaintext = new Uint8Array(Math.floor(2.5 * STREAM_CHUNK_SIZE));
    for (let i = 0; i < plaintext.length; i += 4096) {
      plaintext[i] = (i / 4096) % 251;
    }
    // Group encryption exactly the way the part uploader does: header plus
    // sealed chunks, concatenated across arbitrary part boundaries.
    const encryptor = new StreamEncryptor(key);
    const pieces: Uint8Array[] = [encryptor.header];
    const chunkCount = Math.max(1, Math.ceil(plaintext.length / STREAM_CHUNK_SIZE));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = plaintext.subarray(i * STREAM_CHUNK_SIZE, Math.min((i + 1) * STREAM_CHUNK_SIZE, plaintext.length));
      pieces.push(encryptor.push(chunk, i === chunkCount - 1));
    }
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      assembled.set(piece, offset);
      offset += piece.length;
    }
    expect(assembled.length).toBe(streamCiphertextSize(plaintext.length));
    expect(Buffer.from(decryptBytes(assembled, key)).equals(Buffer.from(plaintext))).toBe(true);
  });
});

describe("chunked media format", () => {
  beforeAll(async () => {
    await ready();
  });

  function makePlain(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 977) {
      bytes[i] = (i / 977) % 251;
    }
    return bytes;
  }

  it("round-trips across chunk boundaries and predicts its size", () => {
    const key = generateKey();
    for (const size of [1, CHUNKED_CHUNK_SIZE, CHUNKED_CHUNK_SIZE + 1, Math.floor(2.5 * CHUNKED_CHUNK_SIZE)]) {
      const plain = makePlain(size);
      const sealed = chunkedEncrypt(plain, key);
      expect(sealed.length).toBe(chunkedCiphertextSize(size));
      const opened = chunkedDecrypt(sealed, key);
      expect(Buffer.from(opened).equals(Buffer.from(plain))).toBe(true);
    }
  });

  it("is detectable against the sequential stream format", () => {
    const key = generateKey();
    const chunked = chunkedEncrypt(makePlain(64), key);
    const stream = encryptBytes(makePlain(64), key);
    expect(isChunkedFormat(chunked)).toBe(true);
    expect(isChunkedFormat(stream)).toBe(false);
  });

  it("decrypts a single chunk in isolation for random access", () => {
    const key = generateKey();
    const plain = makePlain(Math.floor(2.5 * CHUNKED_CHUNK_SIZE));
    const sealed = chunkedEncrypt(plain, key);
    const header = readChunkedHeader(sealed);
    expect(header.plainSize).toBe(plain.length);
    const span = chunkSpanForRange(header, CHUNKED_CHUNK_SIZE + 5, CHUNKED_CHUNK_SIZE + 100);
    expect(span.firstChunk).toBe(1);
    expect(span.lastChunk).toBe(1);
    const chunkBytes = sealed.subarray(span.ciphertextStart, span.ciphertextEnd + 1);
    const opened = decryptChunkRange(header, key, chunkBytes, span);
    expect(
      Buffer.from(opened).equals(
        Buffer.from(plain.subarray(CHUNKED_CHUNK_SIZE, 2 * CHUNKED_CHUNK_SIZE)),
      ),
    ).toBe(true);
  });

  it("rejects chunks moved to another position", () => {
    const key = generateKey();
    const plain = makePlain(2 * CHUNKED_CHUNK_SIZE);
    const sealed = chunkedEncrypt(plain, key);
    const header = readChunkedHeader(sealed);
    const a = chunkSpanForRange(header, 0, 0);
    const b = chunkSpanForRange(header, CHUNKED_CHUNK_SIZE, CHUNKED_CHUNK_SIZE);
    // Present chunk 1's ciphertext as if it were chunk 0.
    const moved = sealed.subarray(b.ciphertextStart, b.ciphertextEnd + 1);
    expect(() => decryptChunkRange(header, key, moved, a)).toThrow();
  });

  it("rejects a tampered header", () => {
    const key = generateKey();
    const sealed = chunkedEncrypt(makePlain(64), key);
    const corrupted = new Uint8Array(sealed);
    corrupted[8] = corrupted[8]! ^ 0xff; // inside the salt
    expect(() => chunkedDecrypt(corrupted, key)).toThrow();
  });

  it("uses distinct salts per encryption so re-saves never reuse nonces", () => {
    const key = generateKey();
    const plain = makePlain(64);
    const first = chunkedEncrypt(plain, key);
    const second = chunkedEncrypt(plain, key);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});

describe("content helpers", () => {
  beforeAll(async () => {
    await ready();
  });

  it("decryptContent handles both formats transparently", () => {
    const key = generateKey();
    const plain = new Uint8Array(4096).fill(9);
    expect(Buffer.from(decryptContent(encryptBytes(plain, key), key)).equals(Buffer.from(plain))).toBe(true);
    expect(Buffer.from(decryptContent(chunkedEncrypt(plain, key), key)).equals(Buffer.from(plain))).toBe(true);
  });

  it("streamPlaintextSize inverts streamCiphertextSize", () => {
    for (const size of [0, 1, STREAM_CHUNK_SIZE - 1, STREAM_CHUNK_SIZE, STREAM_CHUNK_SIZE + 1, 3 * STREAM_CHUNK_SIZE + 12345]) {
      expect(streamPlaintextSize(streamCiphertextSize(size))).toBe(size);
    }
  });
});
