import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveKeyEncryptionKey,
  deriveLoginKey,
  generateAccountKeys,
  ready,
  unlockWithPassword,
  type AccountKeys,
  type KeyAttributes,
} from "@engramer/crypto";
import { changePassword, type ChangePasswordDeps } from "./changepassword";

/**
 * The logged-in password change against a fake server: the current
 * password is proven locally and by the login-key digest the server can
 * check, and the new wrapping the server receives is one the new password
 * can actually open. A wrong current password never reaches the server.
 */
describe("changePassword", () => {
  let account: AccountKeys;

  beforeAll(async () => {
    await ready();
    account = generateAccountKeys("the current password");
  });

  const fakeDeps = (): {
    deps: ChangePasswordDeps;
    sent: { currentLoginKey?: string; loginKey?: string; kdf?: unknown; emk?: unknown };
  } => {
    const sent: {
      currentLoginKey?: string;
      loginKey?: string;
      kdf?: unknown;
      emk?: unknown;
    } = {};
    const deps: ChangePasswordDeps = {
      api: {
        keyAttributes: async () => ({ keyAttributes: account.keyAttributes }),
        changePassword: async (currentLoginKey, loginKey, kdf, encryptedMasterKey) => {
          sent.currentLoginKey = currentLoginKey;
          sent.loginKey = loginKey;
          sent.kdf = kdf;
          sent.emk = encryptedMasterKey;
          return { token: "jwt-after-change" };
        },
      },
      setAuthToken: () => {},
    };
    return { deps, sent };
  };

  it("proves the current password by its login-key digest", async () => {
    const { deps, sent } = fakeDeps();
    await changePassword("the current password", "a whole new password", deps);
    const expected = deriveLoginKey(
      deriveKeyEncryptionKey("the current password", account.keyAttributes.kdf).kek,
    );
    expect(sent.currentLoginKey).toBe(expected);
  });

  it("sends a wrapping the new password can open", async () => {
    const { deps, sent } = fakeDeps();
    await changePassword("the current password", "a whole new password", deps);
    const attrs = {
      ...account.keyAttributes,
      kdf: sent.kdf,
      encryptedMasterKey: sent.emk,
    } as KeyAttributes;
    expect(unlockWithPassword("a whole new password", attrs).masterKey).toEqual(account.masterKey);
    // The old password no longer opens the new wrapping.
    expect(() => unlockWithPassword("the current password", attrs)).toThrow();
  });

  it("refuses locally when the current password is wrong", async () => {
    const { deps, sent } = fakeDeps();
    await expect(
      changePassword("not the current password", "a whole new password", deps),
    ).rejects.toThrow();
    // Nothing was sent to the server.
    expect(sent.currentLoginKey).toBeUndefined();
  });

  it("installs the token the server returns", async () => {
    const { deps } = fakeDeps();
    let installed = "";
    deps.setAuthToken = (token) => {
      installed = token;
    };
    await changePassword("the current password", "a whole new password", deps);
    expect(installed).toBe("jwt-after-change");
  });
});
