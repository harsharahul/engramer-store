import { fromB64, secretBoxOpen, secretBoxSeal, type SecretBox } from "@engramer/crypto";

/**
 * What a tab stores so a reload does not cost the password.
 *
 * The keys themselves never touch storage. They are sealed under a random
 * session key the server holds for this one live session and hands back
 * only while the session stands (see /api/auth/session-key). The bearer
 * token rides in the open because it is what fetches that key; on its own
 * it decrypts nothing. So what a browser writes to disk for this tab is
 * ciphertext plus a token: useless once the session is signed out,
 * locked, or revoked from another device, and never enough by itself.
 */

export interface TabSession {
  email: string;
  token: string;
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: string;
}

export interface StoredTabSession {
  v: 2;
  email: string;
  /** The bearer token: what fetches the session key, and nothing more. */
  token: string;
  /** Which server-held session key seals this record. */
  skid: string;
  publicKey: string;
  wrappedMasterKey: SecretBox;
  /** Sealed under the master key, mirroring the account key hierarchy. */
  wrappedPrivateKey: SecretBox;
}

export function sealTabSession(session: TabSession, skid: string, sessionKey: Uint8Array): StoredTabSession {
  return {
    v: 2,
    email: session.email,
    token: session.token,
    skid,
    publicKey: session.publicKey,
    wrappedMasterKey: secretBoxSeal(session.masterKey, sessionKey),
    wrappedPrivateKey: secretBoxSeal(session.privateKey, session.masterKey),
  };
}

/** Throws when the session key is wrong or the record was altered. */
export function openTabSession(stored: StoredTabSession, sessionKey: Uint8Array): TabSession {
  const masterKey = secretBoxOpen(stored.wrappedMasterKey, sessionKey);
  return {
    email: stored.email,
    token: stored.token,
    masterKey,
    privateKey: secretBoxOpen(stored.wrappedPrivateKey, masterKey),
    publicKey: stored.publicKey,
  };
}

/**
 * Reads a stored record; null for anything that is not a current-format
 * record, which covers the pre-wrap format on purpose: those held keys in
 * the clear and are discarded rather than honored.
 */
export function parseStoredTabSession(raw: string | null): StoredTabSession | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTabSession>;
    if (
      parsed.v !== 2 ||
      typeof parsed.email !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.skid !== "string" ||
      typeof parsed.publicKey !== "string" ||
      !parsed.wrappedMasterKey ||
      !parsed.wrappedPrivateKey
    ) {
      return null;
    }
    return parsed as StoredTabSession;
  } catch {
    return null;
  }
}

/** The server's session key, as sent (URL-safe base64, unpadded). */
export function decodeSessionKey(key: string): Uint8Array {
  const bytes = fromB64(key);
  if (bytes.length !== 32) {
    throw new Error("session key has the wrong length");
  }
  return bytes;
}
