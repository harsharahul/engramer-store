import { describe, expect, it } from "vitest";
import { mergeKeyAttributes, ForbiddenKeyChange } from "../src/keyattrs.js";

const stored = {
  kdf: { salt: "salt-a", opsLimit: 3, memLimit: 268435456 },
  encryptedMasterKey: { ciphertext: "emk", nonce: "n1" },
  masterKeyEncryptedWithRecoveryKey: { ciphertext: "mkr", nonce: "n2" },
  recoveryKeyEncryptedWithMasterKey: { ciphertext: "rkm", nonce: "n3" },
  publicKey: "pub",
  encryptedPrivateKey: { ciphertext: "epk", nonce: "n4" },
};

describe("mergeKeyAttributes", () => {
  it("merges exactly the allowed fields", () => {
    const merged = mergeKeyAttributes(
      stored,
      {
        ...stored,
        kdf: { salt: "salt-b", opsLimit: 2, memLimit: 268435456 },
        encryptedMasterKey: { ciphertext: "emk2", nonce: "n5" },
      },
      ["kdf", "encryptedMasterKey"],
    );
    expect(merged.kdf.salt).toBe("salt-b");
    expect(merged.encryptedMasterKey.ciphertext).toBe("emk2");
    expect(merged.publicKey).toBe("pub");
    expect(merged.masterKeyEncryptedWithRecoveryKey.ciphertext).toBe("mkr");
  });

  it("refuses a change outside the allowlist instead of ignoring it", () => {
    expect(() =>
      mergeKeyAttributes(
        stored,
        { ...stored, publicKey: "attacker-pub" },
        ["kdf", "encryptedMasterKey"],
      ),
    ).toThrow(ForbiddenKeyChange);
  });

  it("accepts byte-identical disallowed fields, since clients echo the whole object", () => {
    const merged = mergeKeyAttributes(
      stored,
      { ...stored, encryptedMasterKey: { ciphertext: "emk2", nonce: "n5" } },
      ["kdf", "encryptedMasterKey"],
    );
    expect(merged.encryptedMasterKey.ciphertext).toBe("emk2");
  });

  it("keeps the recovery pair swap to its own allowlist", () => {
    const merged = mergeKeyAttributes(
      stored,
      {
        ...stored,
        masterKeyEncryptedWithRecoveryKey: { ciphertext: "mkr2", nonce: "n6" },
        recoveryKeyEncryptedWithMasterKey: { ciphertext: "rkm2", nonce: "n7" },
      },
      ["masterKeyEncryptedWithRecoveryKey", "recoveryKeyEncryptedWithMasterKey"],
    );
    expect(merged.masterKeyEncryptedWithRecoveryKey.ciphertext).toBe("mkr2");
    expect(merged.encryptedMasterKey.ciphertext).toBe("emk");
  });
});
