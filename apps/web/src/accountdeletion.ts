import {
  deriveKeyEncryptionKey,
  deriveLoginKey,
  secretBoxOpen,
  type KeyAttributes,
} from "@engramer/crypto";

/**
 * Deleting the account starts with proving the password here, before
 * anything is asked of the server: the stored KDF parameters reproduce
 * the key-encryption key, and opening the wrapped master key with it is
 * the check. What the server receives is the login key it already
 * knows the digest of, never the password.
 */
export function deletionProof(password: string, keyAttributes: KeyAttributes): string {
  const { kek } = deriveKeyEncryptionKey(password, keyAttributes.kdf);
  try {
    secretBoxOpen(keyAttributes.encryptedMasterKey, kek);
  } catch {
    throw new Error("That is not your password.");
  }
  return deriveLoginKey(kek);
}
