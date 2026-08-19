import { describe, expect, it, vi } from "vitest";

vi.mock("./cache", () => ({
  loadCache: async () => null,
  storeSyncRows: async () => {},
  clearCache: async () => {},
}));

import { api } from "./api";
import { useStore } from "./store";
import type { Session } from "./session";

/**
 * `synced` turns true straight from the on-device cache so the library is
 * on screen before the network answers. Anything that decides what still
 * needs UPLOADING must not trust that: against the cached snapshot, every
 * file the cache had not seen yet looks missing and gets sent again.
 * `serverSynced` is the honest signal, and it only comes from the server.
 */
describe("serverSynced", () => {
  it("stays down when the sync attempt fails", async () => {
    useStore.setState({
      session: { email: "s@example.com" } as unknown as Session,
      synced: true,
      serverSynced: false,
    });
    vi.spyOn(api, "sync").mockRejectedValueOnce(new Error("radio dead"));
    await expect(useStore.getState().refresh()).rejects.toThrow("radio dead");
    expect(useStore.getState().serverSynced).toBe(false);
  });

  it("flips as soon as a sync round-trip lands", async () => {
    useStore.setState({
      session: { email: "s@example.com" } as unknown as Session,
      synced: true,
      serverSynced: false,
    });
    vi.spyOn(api, "sync").mockResolvedValueOnce({
      seq: 0,
      folders: [],
      files: [],
      shared: [],
    } as never);
    // The flag is stamped the moment the response arrives; whatever the
    // rest of refresh does with the payload is not this test's business.
    await useStore
      .getState()
      .refresh()
      .catch(() => {});
    expect(useStore.getState().serverSynced).toBe(true);
  });
});
