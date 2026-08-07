/**
 * Account-to-account sharing: the key handshake.
 *
 * An invite link conveys identity, never key material: the owner mints an
 * opaque token, the recipient claims it while signed in, and only then does
 * the owner's client seal the file key to the claimant's published public
 * key. The server relays the sealed box and can open none of it. This is
 * the file-request mechanism pointed the other way.
 */

import { openSealed, sealToPublicKey } from "@engramer/crypto";
import type { Session } from "./session";

export type CollabRole = "viewer" | "editor";

/** Seals a file key to a recipient's account public key. */
export function sealFileKeyFor(fileKey: Uint8Array, recipientPublicKey: string): string {
  return sealToPublicKey(fileKey, recipientPublicKey);
}

/** Opens a file key sealed to this account. Throws on any mismatch. */
export function openSharedFileKey(sealed: string, session: Session): Uint8Array {
  return openSealed(sealed, session.publicKey, session.privateKey);
}

/**
 * The invite URL for a token. Deliberately fragment-free: unlike share
 * links, an invite carries no key, so there is nothing to keep out of
 * server logs and nothing a leaked link would decrypt.
 */
export function inviteLink(token: string, origin: string = window.location.origin): string {
  return `${origin}/c/${token}`;
}

/** The token inside an invite path, or null for anything else. */
export function parseInviteToken(pathname: string): string | null {
  const match = /^\/c\/([A-Za-z0-9_-]+)$/.exec(pathname);
  return match ? match[1]! : null;
}
