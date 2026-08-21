import {
  deriveUnlockKey,
  fromB64,
  secretBoxOpen,
  secretBoxSeal,
  toB64,
  utf8Decode,
  utf8Encode,
  type SecretBox,
} from "@engramer/crypto";
import { NATIVE_CANCELLED, nativeSecretDelete, nativeSecretGet, nativeSecretStore } from "./native";
import { diag } from "./diag";

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
  /** The bearer token, sealed under the master key so the stored record
   * carries no usable credential of any kind. */
  sealedToken?: SecretBox;
  /** Records written before the token was sealed carried it here. Read
   * once more so an enrolled device keeps working; rewritten sealed on
   * the next sign-in. */
  token?: string;
  publicKey: string;
  credentialId: string;
  salt: string;
  wrappedMasterKey: SecretBox;
  wrappedPrivateKey: SecretBox;
  createdAt: number;
  /** True when the wrap secret lives in the desktop shell's Keychain
   * (Touch ID) instead of behind a WebAuthn passkey. */
  native?: boolean;
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
    sealedToken: sealToken(session.token, session.masterKey),
    publicKey: session.publicKey,
    credentialId,
    salt,
    wrappedMasterKey: secretBoxSeal(session.masterKey, wrapKey),
    // Re-sealed under the master key, mirroring the account key hierarchy.
    wrappedPrivateKey: secretBoxSeal(session.privateKey, session.masterKey),
    createdAt: Date.now(),
  };
}

function sealToken(token: string, masterKey: Uint8Array): SecretBox {
  return secretBoxSeal(utf8Encode(token), masterKey);
}

export function openUnlockRecord(prfSecret: Uint8Array, record: UnlockRecord): UnlockSession {
  const masterKey = secretBoxOpen(record.wrappedMasterKey, deriveUnlockKey(prfSecret));
  const token = record.sealedToken
    ? utf8Decode(secretBoxOpen(record.sealedToken, masterKey))
    : record.token;
  if (!token) {
    throw new Error("unlock record carries no session");
  }
  return {
    email: record.email,
    token,
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

/** A fresh sign-in renews the 30-day window for the enrolled account. The
 * token is sealed under the master key; a record that still carried it in
 * the clear is rewritten without it. */
export function updateUnlockToken(session: Pick<UnlockSession, "email" | "token" | "masterKey">): void {
  const record = loadUnlockRecord();
  if (record && record.email === session.email) {
    const renewed: UnlockRecord = { ...record, sealedToken: sealToken(session.token, session.masterKey) };
    delete renewed.token;
    saveUnlockRecord(renewed);
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
  let secret: Uint8Array;
  if (record.native) {
    // Desktop shell: the wrap secret sits in the Mac's Keychain behind a
    // Touch ID prompt; the crypto below is identical to the passkey path.
    try {
      secret = fromB64(await nativeSecretGet(record.email));
    } catch (err) {
      diag("unlock", `keychain unlock declined or failed: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
  } else {
    let prf: ArrayBuffer | undefined;
    try {
      prf = await evaluatePrf(fromB64(record.credentialId).slice().buffer as ArrayBuffer, fromB64(record.salt));
    } catch {
      // The user dismissed the prompt or the authenticator refused; keep the
      // record so they can try again, and let the caller fall back.
      return null;
    }
    if (!prf) {
      return null;
    }
    secret = new Uint8Array(prf);
  }
  try {
    return openUnlockRecord(secret, record);
  } catch {
    // Wrong authenticator or corrupted record: unusable, remove it.
    clearUnlockRecord();
    return null;
  }
}

// ----- desktop shell (Keychain + Touch ID) -----

/**
 * Enrolls unlock through the desktop shell: a random secret goes into the
 * Mac's Keychain behind a biometric prompt, and the master key is wrapped
 * under a key derived from that secret, exactly like the passkey flavor.
 */
export async function enrollNativeUnlock(
  session: UnlockSession,
): Promise<"enrolled" | "unsupported" | "cancelled"> {
  const secret = randomBytes(32);
  try {
    await nativeSecretStore(session.email, toB64(secret));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes(NATIVE_CANCELLED) ? "cancelled" : "unsupported";
  }
  saveUnlockRecord({
    ...wrapForUnlock(secret, session, "native", toB64(randomBytes(16))),
    native: true,
  });
  return "enrolled";
}

/** Removes both halves of a native enrollment; safe to call unenrolled. */
export function clearNativeUnlock(): void {
  const record = loadUnlockRecord();
  if (record?.native) {
    void nativeSecretDelete(record.email);
  }
  clearUnlockRecord();
}
