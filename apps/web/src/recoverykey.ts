import {
  deriveKeyEncryptionKey,
  deriveLoginKey,
  openRecoveryKey,
  rewrapRecoveryKey,
  secretBoxOpen,
  type KeyAttributes,
  type SecretBox,
} from "@engramer/crypto";

/**
 * Viewing and rotating the recovery key from a signed-in session. Both
 * are gated on the current password, verified locally by opening the
 * master key; a wrong password throws before anything is shown or sent.
 * Rotation re-seals only the recovery pair, so the password wrapping and
 * every stored byte are untouched, and the old recovery key stops working
 * the moment the server accepts the new wrapping.
 */
export interface RecoveryKeyDeps {
  api: {
    keyAttributes(): Promise<{ keyAttributes: KeyAttributes }>;
    rotateRecoveryKey(
      currentLoginKey: string,
      masterKeyEncryptedWithRecoveryKey: SecretBox,
      recoveryKeyEncryptedWithMasterKey: SecretBox,
    ): Promise<unknown>;
  };
}

async function unlock(
  password: string,
  deps: RecoveryKeyDeps,
): Promise<{ masterKey: Uint8Array; loginKey: string; attributes: KeyAttributes }> {
  const { keyAttributes } = await deps.api.keyAttributes();
  const { kek } = deriveKeyEncryptionKey(password, keyAttributes.kdf);
  // Throws on a wrong password, before anything is revealed or sent.
  const masterKey = secretBoxOpen(keyAttributes.encryptedMasterKey, kek);
  return { masterKey, loginKey: deriveLoginKey(kek), attributes: keyAttributes };
}

/** The current recovery key, for showing it again after a password check. */
export async function revealRecoveryKey(password: string, deps: RecoveryKeyDeps): Promise<string> {
  const { masterKey, attributes } = await unlock(password, deps);
  return openRecoveryKey(masterKey, attributes);
}

/** A fresh recovery key; the old one stops working once this returns. */
export async function rotateRecoveryKey(password: string, deps: RecoveryKeyDeps): Promise<string> {
  const { masterKey, loginKey, attributes } = await unlock(password, deps);
  const rotated = rewrapRecoveryKey(masterKey, attributes);
  await deps.api.rotateRecoveryKey(
    loginKey,
    rotated.keyAttributes.masterKeyEncryptedWithRecoveryKey,
    rotated.keyAttributes.recoveryKeyEncryptedWithMasterKey,
  );
  return rotated.recoveryKeyHex;
}
