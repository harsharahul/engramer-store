import { settingChanged } from "./settingsbus";

/**
 * Pinned account keys: the public key last seen for each person this
 * account has released a file key to.
 *
 * The server is the one that says which public key belongs to an email
 * address, and an end-to-end encrypted share is only as good as that
 * statement. Pinning turns a silent substitution into a visible event:
 * the first key for a person is remembered, and a different key later
 * stops the release until the owner has looked at both fingerprints and
 * chosen to trust the new one. The pins travel with the synced settings,
 * sealed like the rest, so every device of the owner's holds the same
 * expectations.
 */

const PINS_KEY = "engram-key-pins";

export type PinVerdict = "new" | "match" | "changed";

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export function pinnedKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writePins(pins: Record<string, string>): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Storage may be unavailable; the next check simply sees no pin.
  }
}

export function pinnedKey(email: string): string | null {
  return pinnedKeys()[normalize(email)] ?? null;
}

export function checkPin(email: string, publicKey: string): PinVerdict {
  const known = pinnedKey(email);
  if (known === null) {
    return "new";
  }
  return known === publicKey ? "match" : "changed";
}

/** Remembers this key for this person and lets the synced settings know. */
export function pinKey(email: string, publicKey: string): void {
  const pins = pinnedKeys();
  if (pins[normalize(email)] === publicKey) {
    return;
  }
  writePins({ ...pins, [normalize(email)]: publicKey });
  settingChanged();
}

/** Adopts pins from the account's synced settings; the newest word wins. */
export function mergePins(remote: Record<string, string> | undefined): void {
  if (!remote) {
    return;
  }
  writePins({ ...pinnedKeys(), ...remote });
}

export function clearPins(): void {
  try {
    localStorage.removeItem(PINS_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Thrown when a release would seal to a key other than the pinned one. */
export class KeyChangedError extends Error {
  constructor(
    readonly email: string,
    readonly previousFingerprint: string,
    readonly currentFingerprint: string,
  ) {
    super(`the account key for ${email} has changed`);
    this.name = "KeyChangedError";
  }
}
