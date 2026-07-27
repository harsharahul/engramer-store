import {
  ready,
  deriveKeyEncryptionKey,
  deriveLoginKey,
  generateAccountKeys,
  secretBoxOpen,
  toB64,
  fromB64,
  type KeyAttributes,
} from "@engramer/crypto";
import { api, setAuthToken } from "./api";

export interface Session {
  email: string;
  token: string;
  masterKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: string;
}

/**
 * The decrypted master key lives in sessionStorage so a page refresh does not
 * force a full Argon2id re-derivation. sessionStorage is tab-scoped and cleared
 * when the tab closes; anyone with access to a logged-in tab already has the
 * session. Locking (logout) wipes it.
 */
const SESSION_KEY = "engramer-session";

export async function registerAccount(email: string, password: string): Promise<{
  session: Session;
  recoveryKeyHex: string;
}> {
  await ready();
  const account = generateAccountKeys(password);
  const { token } = await api.register(email, account.loginKey, account.keyAttributes);
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

function activate(session: Session): void {
  setAuthToken(session.token);
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      email: session.email,
      token: session.token,
      masterKey: toB64(session.masterKey),
      privateKey: toB64(session.privateKey),
      publicKey: session.publicKey,
    }),
  );
}

export async function restoreSession(): Promise<Session | null> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  await ready();
  try {
    const stored = JSON.parse(raw) as {
      email: string;
      token: string;
      masterKey: string;
      privateKey: string;
      publicKey: string;
    };
    const session: Session = {
      email: stored.email,
      token: stored.token,
      masterKey: fromB64(stored.masterKey),
      privateKey: fromB64(stored.privateKey),
      publicKey: stored.publicKey,
    };
    setAuthToken(session.token);
    return session;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  setAuthToken(null);
}
