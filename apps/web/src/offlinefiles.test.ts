import { beforeEach, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  pinOk: true,
  pinCalls: [] as string[],
  removed: [] as string[],
  pinEvents: null as ((payload: unknown) => void) | null,
  midPin: null as (() => void) | null,
}));

vi.mock("./native", () => ({
  nativeOfflinePin: async (file: { id: string }) => {
    rig.midPin?.();
    rig.pinCalls.push(file.id);
    return rig.pinOk;
  },
  nativeOfflineRemove: async (fileId: string) => {
    rig.removed.push(fileId);
  },
  nativeListen: async (_event: string, handler: (payload: unknown) => void) => {
    rig.pinEvents = handler;
    return () => {
      rig.pinEvents = null;
    };
  },
}));

import { invalidateStaleOffline, offlineExcuse, offlineStale, pinFileOffline } from "./offlinefiles";
import { activeSaves } from "./saveprogress";

beforeEach(() => {
  rig.pinOk = true;
  rig.pinCalls.length = 0;
  rig.removed.length = 0;
  rig.pinEvents = null;
  rig.midPin = null;
});

/**
 * Pinning keeps a file: the shell fills whatever spans are missing,
 * verifies the whole file decrypts, and promises never to evict it.
 * The fill narrates through the same save record as exports, so the
 * overlay tells this story too.
 */
describe("pinFileOffline", () => {
  const file = { id: "f1", name: "clip.mov", key: new Uint8Array(32), digest: "d1" };

  it("narrates the shell's fill progress while the pin runs", async () => {
    rig.midPin = () => {
      rig.pinEvents?.({ fileId: "f1", done: 512, total: 2048 });
      expect(activeSaves()[0]).toMatchObject({ done: 512, total: 2048 });
      rig.pinEvents?.({ fileId: "other", done: 1, total: 2 });
      expect(activeSaves()).toHaveLength(1);
    };
    expect(await pinFileOffline(file, "tok")).toBe(true);
    expect(rig.pinCalls).toEqual(["f1"]);
    expect(activeSaves()).toEqual([]);
    expect(rig.pinEvents).toBeNull();
  });

  it("reports a failed pin and still ends the narration", async () => {
    rig.pinOk = false;
    expect(await pinFileOffline(file, "tok")).toBe(false);
    expect(activeSaves()).toEqual([]);
  });
});

/**
 * A failure with no network must say so: falling through to "too large
 * to play" or a raw fetch error told a person their file was broken
 * when the truth was that they were offline and it was never saved.
 */
describe("offlineExcuse", () => {
  it("names the real problem when offline", () => {
    expect(offlineExcuse(false)).toBe(
      "You're offline, and this file isn't saved for offline access.",
    );
  });

  it("stays quiet online, so the real error can speak", () => {
    expect(offlineExcuse(true)).toBeNull();
  });
});

/**
 * A synced row whose digest moved means the server's bytes are no longer
 * the ones the shell stored: the local copy is stale the moment the
 * delta lands. New files and unchanged rows are not.
 */
describe("offlineStale", () => {
  it("marks a replaced row whose content digest changed", () => {
    expect(offlineStale({ digest: "old" }, { digest: "new" })).toBe(true);
  });

  it("leaves unchanged rows and first appearances alone", () => {
    expect(offlineStale({ digest: "same" }, { digest: "same" })).toBe(false);
    expect(offlineStale(undefined, { digest: "new" })).toBe(false);
  });

  it("treats a digest appearing where none was recorded as a change", () => {
    expect(offlineStale({}, { digest: "new" })).toBe(true);
  });
});

/**
 * Invalidation drops the stale copies the store actually holds and
 * re-pins the ones that were promised: a pin means "keep this file",
 * and the file is now its newer self.
 */
describe("invalidateStaleOffline", () => {
  const entries = [
    { fileId: "pinned-stale", pinned: true, complete: true, bytes: 9 },
    { fileId: "cached-stale", pinned: false, complete: true, bytes: 9 },
  ];

  it("removes stale copies and re-pins only the promised ones", async () => {
    const repinned: string[] = [];
    await invalidateStaleOffline(
      ["pinned-stale", "cached-stale", "never-stored"],
      entries,
      async (id) => {
        repinned.push(id);
      },
    );
    expect(rig.removed).toEqual(["pinned-stale", "cached-stale"]);
    expect(repinned).toEqual(["pinned-stale"]);
  });

  it("does nothing when nothing stale is stored", async () => {
    await invalidateStaleOffline(["never-stored"], entries, async () => {
      throw new Error("no re-pin should happen");
    });
    expect(rig.removed).toEqual([]);
  });
});
