import {
  deriveUnlockKey,
  fromB64,
  secretBoxOpen,
  secretBoxSeal,
  toB64,
  type SecretBox,
} from "@engramer/crypto";

/**
 * Device unlock: reopening the app asks for Touch ID (or any platform
 * passkey) instead of the password. The master key is wrapped under a key
 * derived from the WebAuthn PRF secret, which only the authenticator can
 * reproduce, so the stored record is ciphertext plus routing data; nothing
 * on disk can open the vault by itself. The bearer token rides along so an
 * unlock also restores the server session. It expires server-side, and
 * signing out (or disabling unlock) deletes the whole record.
 */

export interface UnlockSession {
  email: string;
  token: string;
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: string;
}

export interface UnlockRecord {
  email: string;
  token: string;
  publicKey: string;
  credentialId: string;
  salt: string;
  wrappedMasterKey: SecretBox;
  wrappedPrivateKey: SecretBox;
  createdAt: number;
}

const RECORD_KEY = "engram-unlock";
const DECLINED_KEY = "engram-unlock-declined";

// ----- pure crypto over the record -----

export function wrapForUnlock(
  prfSecret: Uint8Array,
  session: UnlockSession,
  credentialId: string,
  salt: string,
): UnlockRecord {
  const wrapKey = deriveUnlockKey(prfSecret);
  return {
    email: session.email,
    token: session.token,
    publicKey: session.publicKey,
    credentialId,
    salt,
    wrappedMasterKey: secretBoxSeal(session.masterKey, wrapKey),
    // Re-sealed under the master key, mirroring the account key hierarchy.
    wrappedPrivateKey: secretBoxSeal(session.privateKey, session.masterKey),
    createdAt: Date.now(),
  };
}

export function openUnlockRecord(prfSecret: Uint8Array, record: UnlockRecord): UnlockSession {
  const masterKey = secretBoxOpen(record.wrappedMasterKey, deriveUnlockKey(prfSecret));
  return {
    email: record.email,
    token: record.token,
    masterKey,
    privateKey: secretBoxOpen(record.wrappedPrivateKey, masterKey),
    publicKey: record.publicKey,
  };
}

// ----- record persistence -----

export function saveUnlockRecord(record: UnlockRecord): void {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // Storage may be unavailable; unlock simply stays unenrolled.
  }
}

export function loadUnlockRecord(): UnlockRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as UnlockRecord) : null;
  } catch {
    return null;
  }
}

export function hasDeviceUnlock(): boolean {
  return loadUnlockRecord() !== null;
}

export function clearUnlockRecord(): void {
  try {
    localStorage.removeItem(RECORD_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** A fresh password login renews the 30-day window for the enrolled account. */
export function updateUnlockToken(email: string, token: string): void {
  const record = loadUnlockRecord();
  if (record && record.email === email) {
    saveUnlockRecord({ ...record, token });
  }
}

export function unlockDeclined(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markUnlockDeclined(): void {
  try {
    localStorage.setItem(DECLINED_KEY, "1");
  } catch {
    // Best effort.
  }
}

// ----- WebAuthn (browser only) -----

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** True when this browser can even attempt passkey unlock. PRF support is
 * only truly knowable by trying, so callers treat enroll as the real test. */
export async function deviceUnlockSupported(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      return false;
    }
    // WebAuthn refuses IP addresses as relying-party ids (localhost is the
    // one special case), so an instance visited by raw IP can never enroll.
    const host = location.hostname;
    if (host !== "localhost" && (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("["))) {
      return false;
    }
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Creates a platform passkey with the PRF extension and stores the wrapped
 * record. "enrolled" on success; "cancelled" when the user dismissed the
 * prompt (worth offering again); "unsupported" when this origin or
 * authenticator cannot yield a PRF secret (nothing is stored either way).
 */
export async function enrollDeviceUnlock(
  session: UnlockSession,
): Promise<"enrolled" | "unsupported" | "cancelled"> {
  const salt = randomBytes(32);
  let credential: PublicKeyCredential | null;
  try {
    credential = await createUnlockCredential(session, salt);
  } catch (error) {
    return error instanceof DOMException && error.name === "NotAllowedError" ? "cancelled" : "unsupported";
  }
  if (!credential) {
    return "unsupported";
  }

  const extensions = credential.getClientExtensionResults() as PrfResults;
  let secret = extensions.prf?.results?.first;
  if (!secret && extensions.prf?.enabled) {
    // Some authenticators only evaluate PRF during assertion; ask once.
    secret = await evaluatePrf(credential.rawId, salt);
  }
  if (!secret) {
    return "unsupported";
  }

  saveUnlockRecord(
    wrapForUnlock(new Uint8Array(secret), session, toB64(new Uint8Array(credential.rawId)), toB64(salt)),
  );
  return "enrolled";
}

async function createUnlockCredential(
  session: UnlockSession,
  salt: Uint8Array,
): Promise<PublicKeyCredential | null> {
  return (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Engram Store", id: location.hostname },
      user: {
        id: randomBytes(16),
        name: session.email,
        displayName: session.email,
      },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
}

async function evaluatePrf(credentialId: BufferSource, salt: Uint8Array): Promise<ArrayBuffer | undefined> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const extensions = assertion?.getClientExtensionResults() as PrfResults | undefined;
  return extensions?.prf?.results?.first;
}

/**
 * Prompts the authenticator and returns the restored session, or null when
 * no record exists or the user dismissed the prompt. Corrupt records are
 * cleared so the password path takes over cleanly.
 */
export async function deviceUnlock(): Promise<UnlockSession | null> {
  const record = loadUnlockRecord();
  if (!record) {
    return null;
  }
  let secret: ArrayBuffer | undefined;
  try {
    secret = await evaluatePrf(fromB64(record.credentialId).slice().buffer as ArrayBuffer, fromB64(record.salt));
  } catch {
    // The user dismissed the prompt or the authenticator refused; keep the
    // record so they can try again, and let the caller fall back.
    return null;
  }
  if (!secret) {
    return null;
  }
  try {
    return openUnlockRecord(new Uint8Array(secret), record);
  } catch {
    // Wrong authenticator or corrupted record: unusable, remove it.
    clearUnlockRecord();
    return null;
  }
}
