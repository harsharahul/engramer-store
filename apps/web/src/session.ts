import {
  ready,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  generateAccountKeys,
  secretBoxOpen,
  type KeyAttributes,
} from "@engramer/crypto";
import { api, ApiError, setAuthToken } from "./api";
import { diag } from "./diag";
import { clearHandoff, refreshHandoff } from "./handoff";
import { clearNativeUnlock, deviceUnlock, updateUnlockToken } from "./unlock";
import { nativeMediaClear } from "./native";
import {
  decodeSessionKey,
  openTabSession,
  parseStoredTabSession,
  sealTabSession,
} from "./tabsession";

export interface Session {
  email: string;
  token: string;
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: string;
}

/**
 * The decrypted keys live in this module's memory and nowhere else on the
 * device. So that a reload does not cost the password, the tab also keeps
 * a record in sessionStorage: the keys sealed under a random session key
 * the server holds for this one live session (see tabsession.ts). A
 * reload asks the server for that key; signing out or locking deletes it,
 * and "sign out everywhere" deletes every device's. What a browser may
 * write to disk for this tab is therefore ciphertext, never a key.
 */
const SESSION_KEY = "engramer-session";

export async function registerAccount(
  email: string,
  password: string,
  inviteToken?: string,
): Promise<{
  session: Session;
  recoveryKeyHex: string;
}> {
  await ready();
  const account = generateAccountKeys(password);
  const { token } = await api.register(email, account.loginKey, account.keyAttributes, inviteToken);
  const session: Session = {
    email,
    token,
    masterKey: account.masterKey,
    privateKey: account.privateKey,
    publicKey: account.keyAttributes.publicKey,
  };
  activate(session);
  return { session, recoveryKeyHex: account.recoveryKeyHex };
}

export type LoginResult =
  | { kind: "session"; session: Session }
  | { kind: "two-factor"; complete: (code: string) => Promise<Session> };

export async function login(email: string, password: string): Promise<LoginResult> {
  await ready();
  const { kdf } = await api.kdfAttributes(email);
  // One derivation covers both authentication and unlocking.
  const { kek } = deriveKeyEncryptionKey(password, kdf);
  const response = await api.login(email, deriveLoginKey(kek));

  const finish = (token: string, attributes: KeyAttributes): Session => {
    const masterKey = secretBoxOpen(attributes.encryptedMasterKey, kek);
    const session = sessionFromKeys(email, token, masterKey, attributes);
    activate(session);
    return session;
  };

  if (response.twoFactorRequired && response.pendingToken) {
    // The password checked out; the server withholds key material until a
    // second factor is presented. The derived KEK stays in this closure so
    // the user never types the password twice.
    const pendingToken = response.pendingToken;
    return {
      kind: "two-factor",
      complete: async (code: string) => {
        const done = await api.twoFactor(pendingToken, code);
        return finish(done.token, done.keyAttributes);
      },
    };
  }
  return { kind: "session", session: finish(response.token!, response.keyAttributes!) };
}

function sessionFromKeys(
  email: string,
  token: string,
  masterKey: Uint8Array,
  attributes: KeyAttributes,
): Session {
  return {
    email,
    token,
    masterKey,
    privateKey: secretBoxOpen(attributes.encryptedPrivateKey, masterKey),
    publicKey: attributes.publicKey,
  };
}

/** Installs a session everywhere a fresh login would: token, unlock
 * record, extension handoff, and the tab's own storage. */
export function activateSession(session: Session): void {
  activate(session);
}

function activate(session: Session): void {
  setAuthToken(session.token);
  // A fresh login renews the device-unlock record's 30-day token window.
  updateUnlockToken(session);
  // And the extension handoff record's, where this device opted in.
  refreshHandoff(session);
  void persistTabSession(session);
}

/**
 * Writes the tab's reload record: a fresh server-held session key seals
 * the keys, and only the sealed form is stored. Best effort: offline, or
 * against a server without the route, the tab simply will not survive a
 * reload and the unlock gate or the password takes over.
 */
async function persistTabSession(session: Session): Promise<void> {
  // Whatever record a previous activation left is superseded; its key
  // is released so it cannot be presented again.
  releaseStoredSessionKey();
  try {
    const { id, key } = await api.createSessionKey();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sealTabSession(session, id, decodeSessionKey(key))));
  } catch (err) {
    diag("session", `reload record not written: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

/** Deletes this tab's server-held session key, if a record names one. */
function releaseStoredSessionKey(): void {
  const stored = parseStoredTabSession(sessionStorage.getItem(SESSION_KEY));
  sessionStorage.removeItem(SESSION_KEY);
  if (stored) {
    void api.deleteSessionKey(stored.skid).catch(() => {});
  }
}

export async function restoreSession(): Promise<Session | null> {
  const stored = parseStoredTabSession(sessionStorage.getItem(SESSION_KEY));
  if (!stored) {
    // Nothing usable here, including a record from before keys were
    // sealed: that format is discarded rather than honored.
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
  await ready();
  try {
    // The record's token fetches the session key that opens the record;
    // the server answers only while that session still stands.
    setAuthToken(stored.token);
    const { key } = await api.getSessionKey(stored.skid);
    return openTabSession(stored, decodeSessionKey(key));
  } catch (err) {
    setAuthToken(null);
    if (!(err instanceof ApiError)) {
      // No answer at all (offline, or the server unreachable): the record
      // is not refused, merely unverifiable right now. It stays, so the
      // next reload with a connection restores the tab without a password.
      diag("session", `reload record could not be checked: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
    // Revoked, expired, signed out elsewhere, or tampered: the record is
    // worthless and the unlock gate or the password form takes over.
    diag("session", `reload record not honored: ${err.message}`);
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSession(email?: string): void {
  // Signing out is the revocation gesture: the tab's reload record, its
  // server-held key, the shell's Keychain secret, and the extension
  // handoff item all go.
  releaseStoredSessionKey();
  clearNativeUnlock();
  if (email) {
    clearHandoff(email);
  }
  void nativeMediaClear();
  setAuthToken(null);
}

/**
 * Locks without revoking: in-memory keys and the session token go away,
 * but the device-unlock enrollment stays, so Touch ID or the passkey
 * reopens the vault. The extension handoff record also stays, on
 * purpose: extensions exist to work while the app is closed, and the
 * record is already behind the device passcode. Signing out remains the
 * full wipe.
 */
export function suspendSession(): void {
  releaseStoredSessionKey();
  void nativeMediaClear();
  setAuthToken(null);
}

/** Restores a session via the device passkey (Touch ID); null if dismissed. */
export async function restoreDeviceSession(): Promise<Session | null> {
  await ready();
  const unlocked = await deviceUnlock();
  if (!unlocked) {
    return null;
  }
  const session: Session = unlocked;
  activate(session);
  return session;
}
