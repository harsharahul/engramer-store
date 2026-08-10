import { sodium } from "./sodium.js";
import { fromB64, toB64, toHex, fromHex } from "./encoding.js";
import {
  generateKey,
  generateKeyPair,
  openSealed,
  secretBoxOpen,
  secretBoxSeal,
  type SecretBox,
} from "./box.js";

export interface KdfParams {
  salt: string;
  opsLimit: number;
  memLimit: number;
}

/**
 * Everything the server stores about an account's keys. All secret material is
 * ciphertext; the server can verify logins but can never decrypt content.
 */
export interface KeyAttributes {
  kdf: KdfParams;
  encryptedMasterKey: SecretBox;
  masterKeyEncryptedWithRecoveryKey: SecretBox;
  recoveryKeyEncryptedWithMasterKey: SecretBox;
  publicKey: string;
  encryptedPrivateKey: SecretBox;
}

export interface AccountKeys {
  keyAttributes: KeyAttributes;
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  /** Shown to the user exactly once; the only way back in after a lost password. */
  recoveryKeyHex: string;
  /** Sent to the server in place of the password. One-way derived from the KEK. */
  loginKey: string;
}

const LOGIN_KDF_CONTEXT = "es-login";
const UNLOCK_KDF_CONTEXT = "es-unlck";

/**
 * Derives the key encryption key with Argon2id.
 *
 * The default is libsodium's moderate profile: 256 MiB and 3 passes, roughly an
 * order of magnitude above the OWASP floor for Argon2id, and affordable on
 * phones and in browser tabs. The sensitive profile (1 GiB) is deliberately not
 * the default: a single allocation that large exhausts the heap on mobile
 * Safari and on CI runners, and a login the user cannot complete protects
 * nothing. If even the moderate allocation fails, memory halves and passes
 * double (holding total work roughly constant) until the platform can afford
 * it. Whatever succeeded is recorded in KdfParams, so every later derivation
 * for that account repeats exactly the same cost.
 */
/**
 * Floor for accepted Argon2id work, at the OWASP minimum. Parameters
 * arrive from the server before login, so a hostile or compromised server
 * could otherwise hand back trivial ones, watch the client derive a
 * cheap login key, and crack the password offline in seconds. Refusing
 * anything below the floor makes that attack fail loudly instead of
 * silently. It is also the floor for local degradation: memory hardness
 * IS the defense, so there is no acceptable "weaker but faster" fallback.
 */
export const MIN_OPS_LIMIT = 2;
export const MIN_MEM_LIMIT = 19 * 1024 * 1024;

export class WeakKdfError extends Error {
  constructor() {
    super("this server offered unsafe password-hashing parameters");
  }
}

export function deriveKeyEncryptionKey(
  password: string,
  kdf?: KdfParams,
): { kek: Uint8Array; kdf: KdfParams } {
  const s = sodium();
  if (kdf) {
    if (
      kdf.opsLimit < MIN_OPS_LIMIT ||
      kdf.memLimit < MIN_MEM_LIMIT ||
      fromB64(kdf.salt).length !== s.crypto_pwhash_SALTBYTES
    ) {
      throw new WeakKdfError();
    }
    const kek = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      password,
      fromB64(kdf.salt),
      kdf.opsLimit,
      kdf.memLimit,
      s.crypto_pwhash_ALG_ARGON2ID13,
    );
    return { kek, kdf };
  }

  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  let opsLimit = s.crypto_pwhash_OPSLIMIT_MODERATE;
  let memLimit = s.crypto_pwhash_MEMLIMIT_MODERATE;
  for (;;) {
    try {
      const kek = s.crypto_pwhash(
        s.crypto_secretbox_KEYBYTES,
        password,
        salt,
        opsLimit,
        memLimit,
        s.crypto_pwhash_ALG_ARGON2ID13,
      );
      return { kek, kdf: { salt: toB64(salt), opsLimit, memLimit } };
    } catch (err) {
      // Halving memory while doubling passes keeps total work roughly
      // constant but throws away the memory hardness that actually
      // resists cracking hardware, so the retry stops at the floor and
      // fails rather than persisting weak parameters forever.
      memLimit = Math.floor(memLimit / 2);
      opsLimit = opsLimit * 2;
      if (memLimit < MIN_MEM_LIMIT) {
        throw err;
      }
    }
  }
}

/** One-way subkey of the KEK used to authenticate. Cannot be inverted to the KEK. */
export function deriveLoginKey(kek: Uint8Array): string {
  const s = sodium();
  return toB64(s.crypto_kdf_derive_from_key(32, 1, LOGIN_KDF_CONTEXT, kek));
}

/** BLAKE2b digest of the login key; the only authentication material the server keeps. */
export function loginKeyDigest(loginKey: string): string {
  const s = sodium();
  return toB64(s.crypto_generichash(32, fromB64(loginKey), null));
}

/**
 * Derives the master-key wrapping key for device unlock from an
 * authenticator-held secret (the WebAuthn PRF output). The secret is hashed
 * first so any input length is accepted, then domain-separated through the
 * KDF so it can never collide with the login key derivation.
 */
export function deriveUnlockKey(secret: Uint8Array): Uint8Array {
  const s = sodium();
  const seed = s.crypto_generichash(32, secret, null);
  return s.crypto_kdf_derive_from_key(32, 1, UNLOCK_KDF_CONTEXT, seed);
}

/** Runs the full signup key ceremony on the client. */
export function generateAccountKeys(password: string): AccountKeys {
  const masterKey = generateKey();
  const recoveryKey = generateKey();
  const { kek, kdf } = deriveKeyEncryptionKey(password);
  const pair = generateKeyPair();

  const keyAttributes: KeyAttributes = {
    kdf,
    encryptedMasterKey: secretBoxSeal(masterKey, kek),
    masterKeyEncryptedWithRecoveryKey: secretBoxSeal(masterKey, recoveryKey),
    recoveryKeyEncryptedWithMasterKey: secretBoxSeal(recoveryKey, masterKey),
    publicKey: pair.publicKey,
    encryptedPrivateKey: secretBoxSeal(pair.privateKey, masterKey),
  };

  return {
    keyAttributes,
    masterKey,
    privateKey: pair.privateKey,
    recoveryKeyHex: toHex(recoveryKey),
    loginKey: deriveLoginKey(kek),
  };
}

export interface UnlockedAccount {
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  loginKey: string;
}

/** Decrypts the master key locally from the password. Throws on a wrong password. */
export function unlockWithPassword(
  password: string,
  attributes: KeyAttributes,
): UnlockedAccount {
  const { kek } = deriveKeyEncryptionKey(password, attributes.kdf);
  const masterKey = secretBoxOpen(attributes.encryptedMasterKey, kek);
  const privateKey = secretBoxOpen(attributes.encryptedPrivateKey, masterKey);
  return { masterKey, privateKey, loginKey: deriveLoginKey(kek) };
}

/** Recovers the master key from the recovery key after a lost password. */
export function unlockWithRecoveryKey(
  recoveryKeyHex: string,
  attributes: KeyAttributes,
): Uint8Array {
  return secretBoxOpen(attributes.masterKeyEncryptedWithRecoveryKey, fromHex(recoveryKeyHex));
}

/**
 * Re-wraps the master key under a new password. Only the wrapping changes;
 * no stored content is touched.
 */
export function rewrapMasterKey(
  newPassword: string,
  masterKey: Uint8Array,
  attributes: KeyAttributes,
): { keyAttributes: KeyAttributes; loginKey: string } {
  const { kek, kdf } = deriveKeyEncryptionKey(newPassword);
  return {
    keyAttributes: {
      ...attributes,
      kdf,
      encryptedMasterKey: secretBoxSeal(masterKey, kek),
    },
    loginKey: deriveLoginKey(kek),
  };
}

/** Opens the recovery key itself, for re-displaying it to its owner. */
export function openRecoveryKey(masterKey: Uint8Array, attributes: KeyAttributes): string {
  return toHex(secretBoxOpen(attributes.recoveryKeyEncryptedWithMasterKey, masterKey));
}

/**
 * A fresh recovery key, both directions re-sealed. Only the recovery
 * wrapping changes: the password wrapping, the keypair and every stored
 * byte stay exactly as they were, so rotation is safe to do casually.
 */
export function rewrapRecoveryKey(
  masterKey: Uint8Array,
  attributes: KeyAttributes,
): { keyAttributes: KeyAttributes; recoveryKeyHex: string } {
  const recoveryKey = generateKey();
  return {
    keyAttributes: {
      ...attributes,
      masterKeyEncryptedWithRecoveryKey: secretBoxSeal(masterKey, recoveryKey),
      recoveryKeyEncryptedWithMasterKey: secretBoxSeal(recoveryKey, masterKey),
    },
    recoveryKeyHex: toHex(recoveryKey),
  };
}

/**
 * Proves possession of the account to a server that knows only ciphertext:
 * the recovery key opens the master key, the master key opens the private
 * key, and the private key opens a challenge the server sealed to the
 * account's public key. Sealed boxes are receiver-only-open, so returning
 * the nonce proves the caller holds the private key and nothing else.
 */
export function proveRecoveryPossession(
  recoveryKeyHex: string,
  attributes: KeyAttributes,
  sealedChallenge: string,
): { masterKey: Uint8Array; privateKey: Uint8Array; nonce: Uint8Array } {
  const masterKey = unlockWithRecoveryKey(recoveryKeyHex, attributes);
  const privateKey = secretBoxOpen(attributes.encryptedPrivateKey, masterKey);
  const nonce = openSealed(sealedChallenge, attributes.publicKey, privateKey);
  return { masterKey, privateKey, nonce };
}
