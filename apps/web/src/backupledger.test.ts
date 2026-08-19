import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackupLedger, resetBackupLedger } from "./backupledger";

// The ledger lives in localStorage; give the node test env one.
beforeAll(() => {
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
});

beforeEach(() => localStorage.clear());

/**
 * The ledger answers one question the library alone cannot: has this
 * account EVER uploaded this photo? Vault rows disappear when a file is
 * deleted forever, and a trashed row is one restore away from living
 * again, so neither is a safe "never uploaded" signal. Without the
 * ledger, deleting backed-up photos re-arms them and a bulk delete
 * re-uploads the entire library.
 */
describe("BackupLedger", () => {
  it("remembers uploads across instances", () => {
    const ledger = new BackupLedger("a@example.com");
    expect(ledger.has("asset-1")).toBe(false);
    ledger.add("asset-1");
    expect(new BackupLedger("a@example.com").has("asset-1")).toBe(true);
  });

  it("absorbs every stamped file in the library, trashed included", () => {
    const ledger = new BackupLedger("a@example.com");
    ledger.absorb([
      { sourceId: "asset-live" },
      { sourceId: "asset-trashed", trashed: true },
      // A file uploaded by hand carries no stamp; there is nothing to learn.
      { sourceId: undefined },
    ]);
    const again = new BackupLedger("a@example.com");
    expect(again.has("asset-live")).toBe(true);
    expect(again.has("asset-trashed")).toBe(true);
  });

  it("keeps accounts separate and resets only the asked-for one", () => {
    const a = new BackupLedger("a@example.com");
    const b = new BackupLedger("b@example.com");
    a.add("asset-1");
    b.add("asset-1");
    resetBackupLedger("a@example.com");
    expect(new BackupLedger("a@example.com").has("asset-1")).toBe(false);
    expect(new BackupLedger("b@example.com").has("asset-1")).toBe(true);
  });

  it("reads corrupt storage as empty and recovers on the next write", () => {
    localStorage.setItem("engram-backup-ledger:a@example.com", "not json");
    const ledger = new BackupLedger("a@example.com");
    expect(ledger.has("asset-1")).toBe(false);
    ledger.add("asset-1");
    expect(new BackupLedger("a@example.com").has("asset-1")).toBe(true);
  });
});
