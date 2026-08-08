import { secretBoxSeal, toB64 } from "@engramer/crypto";
import {
  nativeFilesProviderDisable,
  nativeFilesProviderEnable,
  nativeHandoffAvailable,
  nativeHandoffClear,
  nativeHandoffGet,
  nativeHandoffStore,
} from "./native";
import type { Session } from "./session";

/**
 * The extension handoff: everything a Files-app provider, share
 * extension, or backup task needs to act for this account without a web
 * view, stored as one keychain item shared with those extensions.
 *
 * Turning this on is a deliberate change to where key material lives:
 * the master key, until now confined to this tab's memory, is persisted
 * behind the device passcode (this device only, never in iCloud). It is
 * opt-in per device, refreshed on every sign-in so the token inside
 * never goes stale, kept through a lock on purpose, and removed on
 * sign-out, which remains the revocation gesture.
 */

export interface HandoffRecord {
  v: 1;
  email: string;
  origin: string;
  token: string;
  tokenIssuedAt: number;
  masterKey: string;
  publicKey: string;
  encryptedPrivateKey: { ciphertext: string; nonce: string };
  createdAt: number;
}

const ENABLED_KEY = "engram-handoff-enabled";

export function handoffEnabled(email: string): boolean {
  return localStorage.getItem(ENABLED_KEY) === email;
}

export async function handoffSupported(): Promise<boolean> {
  return nativeHandoffAvailable();
}

function buildRecord(session: Session): HandoffRecord {
  return {
    v: 1,
    email: session.email,
    origin: window.location.origin,
    token: session.token,
    tokenIssuedAt: Date.now(),
    masterKey: toB64(session.masterKey),
    publicKey: session.publicKey,
    // The same wrap the account hierarchy uses; resealed here so the
    // record is self-contained (a fresh nonce changes nothing).
    encryptedPrivateKey: secretBoxSeal(session.privateKey, session.masterKey),
    createdAt: Date.now(),
  };
}

/** Turns the handoff on for this device and writes the current session. */
export async function enableHandoff(session: Session): Promise<void> {
  await nativeHandoffStore(session.email, JSON.stringify(buildRecord(session)));
  localStorage.setItem(ENABLED_KEY, session.email);
  // The Files-app drive can only read once the key is in place, so it
  // is registered here and removed with the key below.
  await nativeFilesProviderEnable(session.email);
}

/** Turns it off, removes the keychain item, and unregisters the drive. */
export async function disableHandoff(email: string): Promise<void> {
  localStorage.removeItem(ENABLED_KEY);
  await nativeFilesProviderDisable(email);
  await nativeHandoffClear(email);
}

/**
 * Called from `activate()` on every sign-in: if this device opted in, the
 * record is rewritten so the 30-day token inside tracks the freshest one
 * (there is no refresh endpoint; sign-in is the renewal).
 */
export function refreshHandoff(session: Session): void {
  if (!handoffEnabled(session.email)) {
    return;
  }
  void nativeHandoffStore(session.email, JSON.stringify(buildRecord(session))).catch(() => {});
}

/** Sign-out revocation: removes the record regardless of the toggle. */
export function clearHandoff(email: string): void {
  void nativeHandoffClear(email);
  if (handoffEnabled(email)) {
    localStorage.removeItem(ENABLED_KEY);
  }
}

/** For diagnostics: whether a record currently exists in the keychain. */
export async function handoffPresent(email: string): Promise<boolean> {
  return (await nativeHandoffGet(email)) !== null;
}
