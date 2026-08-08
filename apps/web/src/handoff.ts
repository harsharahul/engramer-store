import { secretBoxSeal, toB64 } from "@engramer/crypto";
import {
  nativeFilesProviderDisable,
  nativeFilesProviderEnable,
  nativeFilesProviderSignal,
  nativeHandoffAvailable,
  nativeHandoffClear,
  nativeHandoffGet,
  nativeHandoffProbe,
  nativeHandoffStore,
  type HandoffProbeResult,
} from "./native";
import type { Session } from "./session";
import { useStore } from "./store";

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
  /** Where the share sheet's "Smart classify" saves: the Inbox folder. */
  inboxFolderId?: string;
}

/**
 * The share sheet's Smart classify destination: a root folder named
 * Inbox, found or (once the library has synced) created. Never creates
 * before the first sync lands, which is what keeps a fresh install from
 * planting a duplicate.
 */
async function ensureInboxFolderId(): Promise<string | undefined> {
  try {
    const find = (): string | undefined => {
      for (const folder of useStore.getState().folders.values()) {
        if (!folder.parentId && folder.name.trim().toLowerCase() === "inbox") {
          return folder.id;
        }
      }
      return undefined;
    };
    const existing = find();
    if (existing) {
      return existing;
    }
    if (!useStore.getState().synced) {
      return undefined;
    }
    await useStore.getState().createFolder("Inbox", null);
    return find();
  } catch {
    return undefined;
  }
}

const ENABLED_KEY = "engram-handoff-enabled";

export function handoffEnabled(email: string): boolean {
  return localStorage.getItem(ENABLED_KEY) === email;
}

export async function handoffSupported(): Promise<boolean> {
  return nativeHandoffAvailable();
}

function buildRecord(session: Session, inboxFolderId?: string): HandoffRecord {
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
    inboxFolderId,
  };
}

/** Turns the handoff on for this device and writes the current session. */
export async function enableHandoff(session: Session): Promise<void> {
  const inboxFolderId = await ensureInboxFolderId();
  await nativeHandoffStore(session.email, JSON.stringify(buildRecord(session, inboxFolderId)));
  localStorage.setItem(ENABLED_KEY, session.email);
  // The Files-app drive can only read once the key is in place, so it
  // is registered here and removed with the key below. The signal wakes
  // any provider instance that came up before the key existed.
  await nativeFilesProviderEnable(session.email);
  await nativeFilesProviderSignal(session.email);
}

/** Turns it off, removes the keychain item, and unregisters the drive. */
export async function disableHandoff(email: string): Promise<void> {
  localStorage.removeItem(ENABLED_KEY);
  await nativeFilesProviderDisable(email);
  await nativeHandoffClear(email);
}

/**
 * Called from `activate()` on every sign-in and from the foreground hook
 * below: if this device opted in, the record is rewritten so the 30-day
 * token inside tracks the freshest one (there is no refresh endpoint;
 * sign-in is the renewal). The drive is re-asserted and signaled in the
 * same pass, which is what makes "open the app to connect" actually
 * connect: a provider that spawned before the key existed gets nudged to
 * look again.
 */
export function refreshHandoff(session: Session): void {
  if (!handoffEnabled(session.email)) {
    return;
  }
  void (async () => {
    const inboxFolderId = await ensureInboxFolderId();
    await nativeHandoffStore(session.email, JSON.stringify(buildRecord(session, inboxFolderId)));
    await nativeFilesProviderEnable(session.email);
    await nativeFilesProviderSignal(session.email);
  })().catch(() => {});
}

/**
 * Rewrites the record on every foreground AND background transition.
 * iOS sends people to the app from the Files app ("open the app to
 * connect"), so coming forward must reconnect; and leaving for the
 * share sheet is exactly when the record should be freshest.
 * Idempotent to install.
 */
let foregroundRefreshInstalled = false;
export function installHandoffForegroundRefresh(current: () => Session | null): void {
  if (foregroundRefreshInstalled) {
    return;
  }
  foregroundRefreshInstalled = true;
  document.addEventListener("visibilitychange", () => {
    const session = current();
    if (session) {
      refreshHandoff(session);
    }
  });
}

/**
 * The connection check behind the Extensions setting: rewrites the
 * record, then reads it back exactly the way the extensions do.
 */
export async function reconnectHandoff(session: Session): Promise<HandoffProbeResult> {
  await enableHandoff(session);
  return nativeHandoffProbe();
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
