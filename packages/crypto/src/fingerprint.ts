import { sodium } from "./sodium.js";
import { fromB64 } from "./encoding.js";

/**
 * A short, human-comparable rendering of an account's public key: the
 * BLAKE2b-128 digest of the raw key, as eight groups of four hex digits.
 *
 * Account-to-account sharing seals a file key to a public key the server
 * supplies. Two people who read the same eight groups to each other over
 * a call hold the same key, whatever the server said; that comparison is
 * what the fingerprint exists for.
 */
export function publicKeyFingerprint(publicKey: string): string {
  const s = sodium();
  const hex = s.to_hex(s.crypto_generichash(16, fromB64(publicKey), null));
  return hex.match(/.{4}/g)!.join(" ");
}
