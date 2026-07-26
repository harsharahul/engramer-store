import { sodium } from "./sodium.js";
import { toB64 } from "./encoding.js";
import { secretBoxSeal, secretBoxOpen, type SecretBox } from "./box.js";
import { deriveKeyEncryptionKey, loginKeyDigest, type KdfParams } from "./keys.js";

const SHARE_KDF_CONTEXT = "es-share";

/**
 * Everything a password-protected share link needs. The server stores the KDF
 * parameters, the wrapped file key, and a digest of the access key; none of
 * them are useful without the link password. The password itself and the
 * unwrapped file key never leave the client.
 */
export interface ShareProtection {
  kdf: KdfParams;
  /** The file key wrapped under a subkey of the password-derived key. */
  wrappedKey: SecretBox;
  /** Sent by a link visitor as proof of knowing the password. */
  accessKey: string;
  /** BLAKE2b digest of the access key; all the server keeps for verification. */
  accessKeyDigest: string;
}

/** The two independent subkeys a link password unlocks. */
export interface ShareAccess {
  /** Authenticates to the server; cannot be inverted to the wrap key. */
  accessKey: string;
  /** Opens the wrapped file key locally. */
  wrapKey: Uint8Array;
}

function subkeys(linkKek: Uint8Array): ShareAccess {
  const s = sodium();
  return {
    accessKey: toB64(s.crypto_kdf_derive_from_key(32, 1, SHARE_KDF_CONTEXT, linkKek)),
    wrapKey: s.crypto_kdf_derive_from_key(32, 2, SHARE_KDF_CONTEXT, linkKek),
  };
}

/**
 * Protects a share link with a password. Argon2id turns the password into a
 * link KEK; two domain-separated subkeys come out of it: one proves knowledge
 * of the password to the server, the other wraps the file key. The server can
 * gate downloads on the first without ever being able to derive the second.
 */
export function protectShareKey(fileKey: Uint8Array, password: string): ShareProtection {
  const { kek, kdf } = deriveKeyEncryptionKey(password);
  const { accessKey, wrapKey } = subkeys(kek);
  return {
    kdf,
    wrappedKey: secretBoxSeal(fileKey, wrapKey),
    accessKey,
    accessKeyDigest: loginKeyDigest(accessKey),
  };
}

/** Re-derives both link subkeys from the password on the visitor's device. */
export function deriveShareAccess(password: string, kdf: KdfParams): ShareAccess {
  const { kek } = deriveKeyEncryptionKey(password, kdf);
  return subkeys(kek);
}

/** Unwraps the file key with the wrap subkey. Throws on a wrong password. */
export function openShareKey(wrappedKey: SecretBox, access: ShareAccess): Uint8Array {
  return secretBoxOpen(wrappedKey, access.wrapKey);
}

/** Digest check the server runs; mirrors the login-key verification path. */
export function shareAccessDigest(accessKey: string): string {
  return loginKeyDigest(accessKey);
}
