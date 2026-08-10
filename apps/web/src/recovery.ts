import {
  proveRecoveryPossession,
  rewrapMasterKey,
  type KdfParams,
  type KeyAttributes,
  type SecretBox,
} from "@engramer/crypto";
import type { Session } from "./session";

/**
 * The logged-out recovery flow: the recovery key opens the master key,
 * the master key opens the private key, the private key opens the
 * server's sealed challenge, and only then is a new password installed.
 * A wrong recovery key dies here, locally, on the first secretbox; the
 * server never learns more than that a begin was asked for.
 *
 * Dependencies arrive explicitly so the flow is testable without the
 * network or a browser session; Auth wires the real api and activation.
 */

export interface RecoveryDeps {
  api: {
    recoveryBegin(email: string): Promise<{
      challengeId: string;
      publicKey: string;
      masterKeyEncryptedWithRecoveryKey: SecretBox;
      encryptedPrivateKey: SecretBox;
      sealedChallenge: string;
    }>;
    recoveryProve(
      challengeId: string,
      nonce: string,
    ): Promise<{ resetToken: string; twoFactorRequired: boolean }>;
    recoveryTwoFactor(resetToken: string, code: string): Promise<{ resetToken: string }>;
    recoveryFinish(
      resetToken: string,
      loginKey: string,
      kdf: KdfParams,
      encryptedMasterKey: SecretBox,
    ): Promise<{ token: string; keyAttributes: KeyAttributes }>;
  };
  activate(session: Session): void;
}

export type SetPasswordStep = {
  kind: "set-password";
  finish(newPassword: string): Promise<Session>;
};

export type RecoveryStep =
  | SetPasswordStep
  | { kind: "two-factor"; complete(code: string): Promise<SetPasswordStep> };

/** 64 hex characters, however the paper copy chose to space them. */
export function normalizeRecoveryKey(input: string): string {
  const bare = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new Error("a recovery key is 64 characters of 0-9 and a-f");
  }
  return bare;
}

export async function beginRecovery(
  email: string,
  recoveryKeyInput: string,
  deps: RecoveryDeps,
): Promise<RecoveryStep> {
  const recoveryKeyHex = normalizeRecoveryKey(recoveryKeyInput);
  const opened = await deps.api.recoveryBegin(email);
  const attributes = {
    publicKey: opened.publicKey,
    masterKeyEncryptedWithRecoveryKey: opened.masterKeyEncryptedWithRecoveryKey,
    encryptedPrivateKey: opened.encryptedPrivateKey,
  } as KeyAttributes;

  let proof: ReturnType<typeof proveRecoveryPossession>;
  try {
    proof = proveRecoveryPossession(recoveryKeyHex, attributes, opened.sealedChallenge);
  } catch {
    // A decoy for an unknown email fails on the same line, with the same
    // message: the caller cannot tell the difference, by design.
    throw new Error("that recovery key does not open this vault");
  }
  const nonce = new TextDecoder().decode(proof.nonce);
  const proved = await deps.api.recoveryProve(opened.challengeId, nonce);

  const setPassword = (resetToken: string): SetPasswordStep => ({
    kind: "set-password",
    finish: async (newPassword: string) => {
      const rewrapped = rewrapMasterKey(newPassword, proof.masterKey, attributes);
      const done = await deps.api.recoveryFinish(
        resetToken,
        rewrapped.loginKey,
        rewrapped.keyAttributes.kdf,
        rewrapped.keyAttributes.encryptedMasterKey,
      );
      const session: Session = {
        email,
        token: done.token,
        masterKey: proof.masterKey,
        privateKey: proof.privateKey,
        publicKey: done.keyAttributes.publicKey,
      };
      deps.activate(session);
      return session;
    },
  });

  if (proved.twoFactorRequired) {
    return {
      kind: "two-factor",
      complete: async (code: string) => {
        const upgraded = await deps.api.recoveryTwoFactor(proved.resetToken, code);
        return setPassword(upgraded.resetToken);
      },
    };
  }
  return setPassword(proved.resetToken);
}
