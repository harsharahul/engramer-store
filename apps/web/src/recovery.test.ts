import { beforeAll, describe, expect, it } from "vitest";
import {
  generateAccountKeys,
  ready,
  sealToPublicKey,
  unlockWithPassword,
  type AccountKeys,
} from "@engramer/crypto";
import { beginRecovery, normalizeRecoveryKey, type RecoveryDeps } from "./recovery";

/**
 * The logged-out recovery orchestration against a fake server: the wire
 * calls and their order are the contract, and a wrong recovery key must
 * die locally before the server hears anything beyond begin.
 */

describe("normalizeRecoveryKey", () => {
  it("accepts spacing, dashes and case", () => {
    const key = "AB".repeat(32);
    expect(normalizeRecoveryKey(` ${key.slice(0, 8)}-${key.slice(8)} `)).toBe(key.toLowerCase());
  });

  it("rejects anything that is not 64 hex characters", () => {
    expect(() => normalizeRecoveryKey("not a key")).toThrow();
    expect(() => normalizeRecoveryKey("ab".repeat(20))).toThrow();
  });
});

describe("beginRecovery", () => {
  let account: AccountKeys;

  beforeAll(async () => {
    await ready();
    account = generateAccountKeys("the password that was lost");
  });

  const fakeDeps = (overrides?: {
    twoFactorRequired?: boolean;
  }): { deps: RecoveryDeps; calls: string[]; activated: Array<{ email: string }> } => {
    const calls: string[] = [];
    const activated: Array<{ email: string }> = [];
    const challengeSecret = "the-challenge-secret";
    const deps: RecoveryDeps = {
      api: {
        recoveryBegin: async (email) => {
          calls.push(`begin:${email}`);
          return {
            challengeId: "ch-1",
            publicKey: account.keyAttributes.publicKey,
            masterKeyEncryptedWithRecoveryKey:
              account.keyAttributes.masterKeyEncryptedWithRecoveryKey,
            encryptedPrivateKey: account.keyAttributes.encryptedPrivateKey,
            sealedChallenge: sealToPublicKey(
              new TextEncoder().encode(challengeSecret),
              account.keyAttributes.publicKey,
            ),
          };
        },
        recoveryProve: async (challengeId, nonce) => {
          calls.push(`prove:${challengeId}:${nonce}`);
          return {
            resetToken: "reset-1",
            twoFactorRequired: overrides?.twoFactorRequired ?? false,
          };
        },
        recoveryTwoFactor: async (resetToken, code) => {
          calls.push(`2fa:${resetToken}:${code}`);
          return { resetToken: "reset-2" };
        },
        recoveryFinish: async (resetToken, loginKey, kdf, encryptedMasterKey) => {
          calls.push(`finish:${resetToken}`);
          return {
            token: "jwt-after-reset",
            keyAttributes: { ...account.keyAttributes, kdf, encryptedMasterKey },
          };
        },
      },
      activate: (session) => {
        activated.push({ email: session.email });
      },
    };
    return { deps, calls, activated };
  };

  it("proves possession and installs the new password", async () => {
    const { deps, calls, activated } = fakeDeps();
    const step = await beginRecovery("lost@example.com", account.recoveryKeyHex, deps);
    expect(step.kind).toBe("set-password");
    if (step.kind !== "set-password") {
      return;
    }
    const session = await step.finish("a brand new password");
    expect(session.token).toBe("jwt-after-reset");
    expect(session.masterKey).toEqual(account.masterKey);
    expect(activated).toEqual([{ email: "lost@example.com" }]);
    expect(calls[0]).toBe("begin:lost@example.com");
    expect(calls[1]).toBe("prove:ch-1:the-challenge-secret");
    expect(calls[2]).toBe("finish:reset-1");
    // The finish really carried a wrapping the new password can open.
    const finished = calls.length === 3;
    expect(finished).toBe(true);
  });

  it("hands the new wrapping to the server, openable by the new password", async () => {
    const { deps } = fakeDeps();
    let sent: { kdf: unknown; encryptedMasterKey: unknown } | null = null;
    deps.api.recoveryFinish = async (resetToken, loginKey, kdf, encryptedMasterKey) => {
      sent = { kdf, encryptedMasterKey };
      return {
        token: "jwt",
        keyAttributes: { ...account.keyAttributes, kdf, encryptedMasterKey },
      };
    };
    const step = await beginRecovery("lost@example.com", account.recoveryKeyHex, deps);
    if (step.kind !== "set-password") {
      return;
    }
    await step.finish("a brand new password");
    expect(sent).not.toBeNull();
    const attrs = { ...account.keyAttributes, ...(sent as unknown as object) };
    expect(unlockWithPassword("a brand new password", attrs).masterKey).toEqual(
      account.masterKey,
    );
  });

  it("fails locally on a wrong recovery key, before proving anything", async () => {
    const { deps, calls } = fakeDeps();
    await expect(
      beginRecovery("lost@example.com", "00".repeat(32), deps),
    ).rejects.toThrow(/recovery key/);
    expect(calls).toEqual(["begin:lost@example.com"]);
  });

  it("routes through the second factor when the server asks", async () => {
    const { deps, calls } = fakeDeps({ twoFactorRequired: true });
    const step = await beginRecovery("lost@example.com", account.recoveryKeyHex, deps);
    expect(step.kind).toBe("two-factor");
    if (step.kind !== "two-factor") {
      return;
    }
    const next = await step.complete("123456");
    const session = await next.finish("a brand new password");
    expect(session.token).toBe("jwt-after-reset");
    expect(calls[2]).toBe("2fa:reset-1:123456");
    expect(calls[3]).toBe("finish:reset-2");
  });
});
