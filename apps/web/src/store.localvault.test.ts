import { beforeAll, describe, expect, it, vi } from "vitest";
import { ready } from "@engramer/crypto";

/**
 * Removing the vault on this device empties this browser's cache before the
 * shell removes the vault. When the shell cannot, the person stays signed
 * in and the library must come back from the vault, not from an emptied
 * cache that still claims a cursor.
 */

const calls = vi.hoisted(() => ({ sync: [] as number[], cacheLoads: 0 }));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: {
      ...original.api,
      keyAttributes: async () => ({ keyAttributes: {} }),
      sync: async (since: number) => {
        calls.sync.push(since);
        return { seq: 6, folders: [], files: [], shared: [] };
      },
    },
  };
});
vi.mock("./accountdeletion", () => ({ deletionProof: () => "proof" }));
vi.mock("./decisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./decisions")>()),
  clearDecisions: () => {},
}));
vi.mock("./cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cache")>()),
  clearCache: async () => {},
  // The first look finds a cache at cursor 6; after the wipe there is none.
  loadCache: async () => (calls.cacheLoads++ === 0 ? { seq: 6, folders: [], files: [], shared: [] } : null),
  storeSyncRows: async () => {},
}));
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  nativeLocalVaultDelete: () => Promise.reject("no native shell"),
  nativeOfflineClear: async () => {},
}));

const { useStore } = await import("./store");

beforeAll(async () => {
  await ready();
});

describe("removing the vault on this device", () => {
  it("starts the next sync from zero when the shell could not remove it", async () => {
    useStore.setState({
      session: { email: "vault@this.device", token: "t" } as never,
      local: { packs: {}, vault: { bytes: 1, directory: "/v" } },
    });
    await useStore.getState().refresh();
    expect(calls.sync).toEqual([6]);

    await expect(useStore.getState().localVaultDelete("pass")).rejects.toThrow("no native shell");
    expect(useStore.getState().session).not.toBeNull();
    // The repair sync runs in the background: from zero, and the rebuilt
    // library sits at the vault's cursor again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.sync).toEqual([6, 0]);
    expect(useStore.getState().synced).toBe(true);
    expect(useStore.getState().syncSeq).toBe(6);
  });
});
