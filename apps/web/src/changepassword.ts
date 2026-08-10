import {
  deriveLoginKey,
  deriveKeyEncryptionKey,
  rewrapMasterKey,
  secretBoxOpen,
  type KdfParams,
  type KeyAttributes,
  type SecretBox,
} from "@engramer/crypto";

/**
 * Changes the vault password from a signed-in session. The current
 * password is proven twice over: locally, by opening the master key it is
 * supposed to wrap (a wrong password throws before any request), and to
 * the server, by the login-key digest it derives. Only the kdf and the
 * password wrapping are re-sealed; the recovery key, the keypair, and
 * every stored byte are untouched, so no data is re-encrypted.
 *
 * Dependencies are passed in so the flow is unit-testable without the
 * network; ProfileView wires the real api and token installer.
 */
export interface ChangePasswordDeps {
  api: {
    keyAttributes(): Promise<{ keyAttributes: KeyAttributes }>;
    changePassword(
      currentLoginKey: string,
      loginKey: string,
      kdf: KdfParams,
      encryptedMasterKey: SecretBox,
    ): Promise<{ token: string }>;
  };
  setAuthToken(token: string): void;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  deps: ChangePasswordDeps,
): Promise<void> {
  const { keyAttributes } = await deps.api.keyAttributes();
  // Deriving with the stored kdf reproduces the current KEK; opening the
  // master key with it is what verifies the current password locally.
  const { kek } = deriveKeyEncryptionKey(currentPassword, keyAttributes.kdf);
  const masterKey = secretBoxOpen(keyAttributes.encryptedMasterKey, kek);
  const currentLoginKey = deriveLoginKey(kek);

  const rewrapped = rewrapMasterKey(newPassword, masterKey, keyAttributes);
  const { token } = await deps.api.changePassword(
    currentLoginKey,
    rewrapped.loginKey,
    rewrapped.keyAttributes.kdf,
    rewrapped.keyAttributes.encryptedMasterKey,
  );
  // The change bumps the token epoch, killing this tab's old token too; the
  // fresh one keeps the session alive without a re-login.
  deps.setAuthToken(token);
}
