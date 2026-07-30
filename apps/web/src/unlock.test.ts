import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKey, ready } from "@engramer/crypto";
import {
  hasDeviceUnlock,
  loadUnlockRecord,
  markUnlockDeclined,
  openUnlockRecord,
  clearUnlockRecord,
  saveUnlockRecord,
  unlockDeclined,
  updateUnlockToken,
  wrapForUnlock,
} from "./unlock";

// The unlock record lives in localStorage; give the node test env one.
function installLocalStorage() {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

function fakeSession() {
  return {
    email: "unlock@example.com",
    token: "jwt-token-1",
    masterKey: generateKey(),
    privateKey: generateKey(),
    publicKey: "pubkey-b64",
  };
}

beforeAll(async () => {
  installLocalStorage();
  await ready();
});

beforeEach(() => {
  clearUnlockRecord();
});

describe("unlock record crypto", () => {
  it("round-trips a session through wrap and open", () => {
    const prf = generateKey();
    const session = fakeSession();
    const record = wrapForUnlock(prf, session, "credential-id-b64", "salt-b64");
    const opened = openUnlockRecord(prf, record);
    expect(opened.email).toBe(session.email);
    expect(opened.token).toBe(session.token);
    expect(opened.publicKey).toBe(session.publicKey);
    expect(Buffer.from(opened.masterKey).equals(Buffer.from(session.masterKey))).toBe(true);
    expect(Buffer.from(opened.privateKey).equals(Buffer.from(session.privateKey))).toBe(true);
  });

  it("rejects the wrong PRF secret", () => {
    const record = wrapForUnlock(generateKey(), fakeSession(), "cred", "salt");
    expect(() => openUnlockRecord(generateKey(), record)).toThrow();
  });

  it("rejects a tampered wrapped master key", () => {
    const prf = generateKey();
    const record = wrapForUnlock(prf, fakeSession(), "cred", "salt");
    const corrupted = {
      ...record,
      wrappedMasterKey: {
        ...record.wrappedMasterKey,
        ciphertext: `${record.wrappedMasterKey.ciphertext.slice(0, -4)}AAAA`,
      },
    };
    expect(() => openUnlockRecord(prf, corrupted)).toThrow();
  });

  it("never stores plaintext key material in the record", () => {
    const session = fakeSession();
    const record = wrapForUnlock(generateKey(), session, "cred", "salt");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(Buffer.from(session.masterKey).toString("base64"));
    expect(serialized).not.toContain(Buffer.from(session.privateKey).toString("base64"));
  });
});

describe("unlock record storage", () => {
  it("saves, loads, and clears the record", () => {
    expect(hasDeviceUnlock()).toBe(false);
    const record = wrapForUnlock(generateKey(), fakeSession(), "cred", "salt");
    saveUnlockRecord(record);
    expect(hasDeviceUnlock()).toBe(true);
    expect(loadUnlockRecord()?.email).toBe("unlock@example.com");
    clearUnlockRecord();
    expect(hasDeviceUnlock()).toBe(false);
    expect(loadUnlockRecord()).toBeNull();
  });

  it("refreshes the stored token for the matching account only", () => {
    const record = wrapForUnlock(generateKey(), fakeSession(), "cred", "salt");
    saveUnlockRecord(record);
    updateUnlockToken("someone-else@example.com", "other-token");
    expect(loadUnlockRecord()?.token).toBe("jwt-token-1");
    updateUnlockToken("unlock@example.com", "jwt-token-2");
    expect(loadUnlockRecord()?.token).toBe("jwt-token-2");
  });

  it("tracks the one-time prompt decline flag", () => {
    expect(unlockDeclined()).toBe(false);
    markUnlockDeclined();
    expect(unlockDeclined()).toBe(true);
  });
});
