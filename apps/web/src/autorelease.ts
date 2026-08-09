/**
 * Pre-authorized key release for personal invitations.
 *
 * An invitation carries no key: whoever claims it must still be granted
 * by the owner's device, which is what keeps a leaked link from ever
 * becoming the key. Naming the person at invite time keeps that
 * guarantee while removing the second trip: the vault releases the key
 * automatically, but only to a claim from exactly that address; anyone
 * else still waits for an explicit approval.
 */

const KEY = "engram-auto-release";

function readMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  localStorage.setItem(KEY, JSON.stringify(map));
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Records who an invitation is meant for. */
export function rememberAutoRelease(token: string, email: string): void {
  const map = readMap();
  map[token] = normalize(email);
  writeMap(map);
}

/** Whether a claim by `claimant` matches the invitation's intended address. */
export function autoReleaseMatches(token: string, claimant: string): boolean {
  const intended = readMap()[token];
  return intended !== undefined && intended === normalize(claimant);
}

/** Drops the record once handled (granted, or declined by the owner). */
export function forgetAutoRelease(token: string): void {
  const map = readMap();
  if (token in map) {
    delete map[token];
    writeMap(map);
  }
}
