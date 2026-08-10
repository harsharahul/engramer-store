import { beforeAll, describe, expect, it } from "vitest";
import {
  generateAccountKeys,
  ready,
  unlockWithRecoveryKey,
  type AccountKeys,
  type KeyAttributes,
} from "@engramer/crypto";
import { revealRecoveryKey, rotateRecoveryKey, type RecoveryKeyDeps } from "./recoverykey";

/**
 * Viewing and rotating the recovery key from a signed-in session, against
 * a fake server. The current password is proven before either; rotation
 * re-seals only the recovery pair and invalidates the old key.
 */
describe("recovery key management", () => {
  let account: AccountKeys;

  beforeAll(async () => {
    await ready();
    account = generateAccountKeys("the vault password");
  });

  const fakeDeps = (): {
    deps: RecoveryKeyDeps;
    stored: { keyAttributes: KeyAttributes };
    sentLoginKey: string[];
  } => {
    const stored = { keyAttributes: account.keyAttributes };
    const sentLoginKey: string[] = [];
    const deps: RecoveryKeyDeps = {
      api: {
        keyAttributes: async () => ({ keyAttributes: stored.keyAttributes }),
        rotateRecoveryKey: async (currentLoginKey, masterKeyEncryptedWithRecoveryKey, recoveryKeyEncryptedWithMasterKey) => {
          sentLoginKey.push(currentLoginKey);
          stored.keyAttributes = {
            ...stored.keyAttributes,
            masterKeyEncryptedWithRecoveryKey,
            recoveryKeyEncryptedWithMasterKey,
          };
        },
      },
    };
    return { deps, stored, sentLoginKey };
  };

  it("reveals the original recovery key to the right password", async () => {
    const { deps } = fakeDeps();
    const shown = await revealRecoveryKey("the vault password", deps);
    expect(shown).toBe(account.recoveryKeyHex);
  });

  it("refuses to reveal with a wrong password", async () => {
    const { deps } = fakeDeps();
    await expect(revealRecoveryKey("wrong password", deps)).rejects.toThrow();
  });

  it("rotates to a new key that opens the vault and retires the old one", async () => {
    const { deps, stored } = fakeDeps();
    const fresh = await rotateRecoveryKey("the vault password", deps);
    expect(fresh).not.toBe(account.recoveryKeyHex);
    // The new key opens the master key against the newly stored attributes.
    expect(unlockWithRecoveryKey(fresh, stored.keyAttributes)).toEqual(account.masterKey);
    // The old key no longer works.
    expect(() => unlockWithRecoveryKey(account.recoveryKeyHex, stored.keyAttributes)).toThrow();
    // The password wrapping was untouched by the rotation.
    expect(stored.keyAttributes.encryptedMasterKey).toEqual(
      account.keyAttributes.encryptedMasterKey,
    );
  });

  it("refuses to rotate with a wrong password, sending nothing", async () => {
    const { deps, sentLoginKey } = fakeDeps();
    await expect(rotateRecoveryKey("wrong password", deps)).rejects.toThrow();
    expect(sentLoginKey).toEqual([]);
  });
});
