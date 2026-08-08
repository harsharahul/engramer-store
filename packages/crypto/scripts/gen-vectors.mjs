/**
 * Writes the TypeScript half of the cross-language test vectors that hold
 * this package and the Rust crate `engram-core` to the same bytes.
 *
 * Two kinds of artifact, in two files:
 *  - vectors.json: deterministic outputs for fixed inputs. Regenerated on
 *    every run; CI regenerates and fails if the committed copy moved, so
 *    no format change can slip through unnoticed.
 *  - sealed.json (+ .bin sidecars): artifacts whose API draws randomness
 *    (nonces, stream headers, ephemeral keys). Written once and kept; they
 *    are inputs for the Rust side to open, not values to reproduce.
 *
 * Run from packages/crypto:  node scripts/gen-vectors.mjs
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ready,
  toB64,
  fromB64,
  contentDigest,
  createDigester,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  loginKeyDigest,
  deriveUnlockKey,
  secretBoxSeal,
  generateKeyPair,
  sealToPublicKey,
  encryptBytes,
  chunkedEncrypt,
  chunkedCiphertextSize,
  streamCiphertextSize,
  streamPlaintextSize,
  encryptFileMetadata,
} from "../src/index.ts";

await ready();

const here = dirname(fileURLToPath(import.meta.url));
const tsDir = join(here, "..", "test", "vectors", "ts");
await mkdir(tsDir, { recursive: true });

const pattern = (n, mul, add) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (i * mul + add) % 256;
  }
  return out;
};

const KEY = pattern(32, 13, 5);
const SECRET = pattern(48, 7, 3);
const SALT = pattern(16, 11, 2);

// ---- deterministic ----

const kdfFloor = { salt: toB64(SALT), opsLimit: 2, memLimit: 19 * 1024 * 1024 };
const kdfMid = { salt: toB64(SALT), opsLimit: 3, memLimit: 64 * 1024 * 1024 };
const kekFloor = deriveKeyEncryptionKey("correct horse battery staple", kdfFloor).kek;
const kekMid = deriveKeyEncryptionKey("pässwörd — unicode", kdfMid).kek;
const loginKey = deriveLoginKey(kekFloor);

const vectors = {
  b64url: [
    { hexIn: "", out: "" },
    { hexIn: "00", out: toB64(fromHexStr("00")) },
    { hexIn: "0001", out: toB64(fromHexStr("0001")) },
    { hexIn: "fbff7e", out: toB64(fromHexStr("fbff7e")) },
    { hexIn: bytesToHex(KEY), out: toB64(KEY) },
  ],
  digest: [
    { hexIn: "", out: contentDigest(new Uint8Array(0)) },
    { hexIn: bytesToHex(pattern(100, 3, 1)), out: contentDigest(pattern(100, 3, 1)) },
    {
      incremental: [bytesToHex(pattern(10, 1, 0)), bytesToHex(pattern(20, 5, 9))],
      out: (() => {
        const d = createDigester();
        d.update(pattern(10, 1, 0));
        d.update(pattern(20, 5, 9));
        return d.final();
      })(),
    },
  ],
  argon2id: [
    { password: "correct horse battery staple", ...kdfFloor, kek: toB64(kekFloor) },
    { password: "pässwörd — unicode", ...kdfMid, kek: toB64(kekMid) },
  ],
  kdf: {
    kek: toB64(kekFloor),
    loginKey,
    loginKeyDigest: loginKeyDigest(loginKey),
    unlockSecretHex: bytesToHex(SECRET),
    unlockKey: toB64(deriveUnlockKey(SECRET)),
  },
  sizes: [0, 1, 100, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9_000_000].map((n) => ({
    plain: n,
    chunked: chunkedCiphertextSize(n),
    stream: streamCiphertextSize(n),
    streamBack: streamPlaintextSize(streamCiphertextSize(n)),
  })),
};

await writeFile(join(tsDir, "vectors.json"), JSON.stringify(vectors, null, 1));
console.log("vectors.json written");

// ---- sealed (write once) ----

const sealedPath = join(tsDir, "sealed.json");
if (existsSync(sealedPath)) {
  console.log("sealed.json already present, kept as committed");
} else {
  const pair = generateKeyPair();
  const streamPlain = pattern(100_000, 17, 11);
  const streamBlob = encryptBytes(streamPlain, KEY);
  const egcPlain = pattern(4 * 1024 * 1024 + 3, 31, 7);
  const egcBlob = chunkedEncrypt(egcPlain, KEY);
  const meta = {
    name: "fixture née photo.heic",
    mime: "image/heic",
    size: 12345,
    mtime: 1_754_500_000_000,
    tags: ["album:fixtures", "sunny"],
    favorite: true,
    digest: contentDigest(streamPlain),
    futureField: { keep: "me" },
  };
  const sealed = {
    keyHex: bytesToHex(KEY),
    secretbox: { plainHex: bytesToHex(pattern(64, 9, 4)), box: secretBoxSeal(pattern(64, 9, 4), KEY) },
    stream: { plainMul: 17, plainAdd: 11, plainLen: streamPlain.length, file: "stream.bin" },
    egc1: { plainMul: 31, plainAdd: 7, plainLen: egcPlain.length, file: "egc1.bin" },
    sealedbox: {
      publicKey: pair.publicKey,
      privateKey: toB64(pair.privateKey),
      message: "sealed across languages",
      sealed: sealToPublicKey(new TextEncoder().encode("sealed across languages"), pair.publicKey),
    },
    metadata: { value: meta, box: encryptFileMetadata(meta, KEY) },
  };
  await writeFile(sealedPath, JSON.stringify(sealed, null, 1));
  await writeFile(join(tsDir, "stream.bin"), streamBlob);
  await writeFile(join(tsDir, "egc1.bin"), egcBlob);
  console.log("sealed.json + blobs written");
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHexStr(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
