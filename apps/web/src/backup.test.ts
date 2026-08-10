import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  backedUp: [] as string[],
}));

vi.mock("./native", () => ({
  nativePhotosAvailable: async () => true,
  nativePhotosAuthorize: async () => "authorized",
  nativePhotosList: async () =>
    Array.from({ length: 6 }, (_, i) => ({
      id: `asset-${i}`,
      kind: "photo",
      screenshot: false,
      created_ms: 1_754_700_000_000 + i,
    })),
  nativePhotoFile: async (id: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new File([new Uint8Array(8)], `${id}.jpg`, { type: "image/jpeg" });
  },
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => ({
      backedUpSourceIds: () => new Set<string>(),
      backupAsset: async (_file: File, sourceId: string) => {
        rig.running++;
        rig.peak = Math.max(rig.peak, rig.running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        rig.running--;
        rig.backedUp.push(sourceId);
        return sourceId;
      },
    }),
  },
}));

vi.mock("./analysisslot", () => ({
  uploadLanes: () => 2,
}));

import { DEFAULT_POLICY, loadPolicy, runBackup, savePolicy, windowStartMs } from "./backup";

// The policy lives in localStorage; give the node test env one.
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

/**
 * The wait in a backup pass is the network, and the phone's analysis slot
 * already guards the memory-hungry half; running the loop one photo at a
 * time wasted the overlap the picker path has had since 0.39.1.
 */
describe("runBackup", () => {
  it("overlaps photos up to the transfer lanes and reports every step", async () => {
    rig.running = 0;
    rig.peak = 0;
    rig.backedUp.length = 0;
    const seen: number[] = [];
    const progress = await runBackup({ ...DEFAULT_POLICY, enabled: true }, (p) =>
      seen.push(p.done),
    );
    expect(progress).toEqual({ done: 6, total: 6, failed: 0 });
    expect(rig.backedUp).toHaveLength(6);
    expect(rig.peak).toBe(2);
    // One initial report, then one per photo, done never decreasing.
    expect(seen).toHaveLength(7);
    expect(seen[0]).toBe(0);
    expect(seen[6]).toBe(6);
  });

  it("stops picking up new photos once aborted", async () => {
    rig.running = 0;
    rig.peak = 0;
    rig.backedUp.length = 0;
    const signal = { aborted: false };
    const progress = await runBackup({ ...DEFAULT_POLICY, enabled: true }, (p) => {
      if (p.done >= 2) {
        signal.aborted = true;
      }
    }, signal);
    expect(progress.done).toBeLessThan(6);
  });
});

describe("backup policy", () => {
  afterEach(() => localStorage.clear());

  it("defaults to off with sensible knobs", () => {
    expect(loadPolicy()).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.enabled).toBe(false);
    expect(DEFAULT_POLICY.wifiOnly).toBe(true);
  });

  it("round-trips a saved policy", () => {
    savePolicy({
      enabled: true,
      includeVideos: false,
      includeScreenshots: false,
      wifiOnly: false,
      window: "30d",
    });
    expect(loadPolicy()).toEqual({
      enabled: true,
      includeVideos: false,
      includeScreenshots: false,
      wifiOnly: false,
      window: "30d",
    });
  });

  it("fills missing keys from the defaults for a forward-compatible stored blob", () => {
    localStorage.setItem("engram-backup-policy", JSON.stringify({ enabled: true }));
    const policy = loadPolicy();
    expect(policy.enabled).toBe(true);
    expect(policy.includeVideos).toBe(DEFAULT_POLICY.includeVideos);
    // Policies saved before backup windows existed cover everything.
    expect(policy.window).toBe("all");
  });

  it("turns each window choice into the right capture-time floor", () => {
    const now = 1_754_700_000_000;
    const base = { ...DEFAULT_POLICY };
    expect(windowStartMs({ ...base, window: "all" }, now)).toBe(0);
    expect(windowStartMs({ ...base, window: "30d" }, now)).toBe(now - 30 * 86_400_000);
    expect(windowStartMs({ ...base, window: "90d" }, now)).toBe(now - 90 * 86_400_000);
    // "Today" pins to the anchor set when it was chosen, not to now.
    expect(windowStartMs({ ...base, window: "today", windowAnchorMs: now - 5000 }, now)).toBe(
      now - 5000,
    );
    // An anchorless "today" (should not happen) fails open, not closed.
    expect(windowStartMs({ ...base, window: "today" }, now)).toBe(0);
  });
});
