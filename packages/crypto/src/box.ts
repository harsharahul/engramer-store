import { sodium } from "./sodium.js";
import { fromB64, toB64, utf8Decode, utf8Encode } from "./encoding.js";

/** An XSalsa20-Poly1305 secretbox: ciphertext plus the nonce it was sealed with. */
export interface SecretBox {
  ciphertext: string;
  nonce: string;
}

/** Generates a random 256-bit key (file keys, folder keys, master key, recovery key). */
export function generateKey(): Uint8Array {
  const s = sodium();
  return s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
}

export function secretBoxSeal(plaintext: Uint8Array, key: Uint8Array): SecretBox {
  const s = sodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, key);
  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce) };
}

/** Throws if the ciphertext was tampered with or the key is wrong. */
export function secretBoxOpen(box: SecretBox, key: Uint8Array): Uint8Array {
  const s = sodium();
  return s.crypto_secretbox_open_easy(fromB64(box.ciphertext), fromB64(box.nonce), key);
}

export function encryptJson(value: unknown, key: Uint8Array): SecretBox {
  return secretBoxSeal(utf8Encode(JSON.stringify(value)), key);
}

export function decryptJson<T>(box: SecretBox, key: Uint8Array): T {
  return JSON.parse(utf8Decode(secretBoxOpen(box, key))) as T;
}

export interface KeyPair {
  publicKey: string;
  privateKey: Uint8Array;
}

/** X25519 key pair for account-to-account sharing. */
export function generateKeyPair(): KeyPair {
  const s = sodium();
  const pair = s.crypto_box_keypair();
  return { publicKey: toB64(pair.publicKey), privateKey: pair.privateKey };
}

/** Seals data to a public key; only the matching private key can open it. */
export function sealToPublicKey(data: Uint8Array, publicKey: string): string {
  const s = sodium();
  return toB64(s.crypto_box_seal(data, fromB64(publicKey)));
}

export function openSealed(sealed: string, publicKey: string, privateKey: Uint8Array): Uint8Array {
  const s = sodium();
  return s.crypto_box_seal_open(fromB64(sealed), fromB64(publicKey), privateKey);
}
