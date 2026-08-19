import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  backedUp: [] as string[],
  fileNames: [] as string[],
  batches: [] as ({ done: number; total: number; current: string } | null)[],
  stops: [] as ((() => void) | null | undefined)[],
  holds: [] as ("wifi" | "shell-videos" | null)[],
  backfills: 0,
  serverSynced: true,
  // Whether the fake shell can serve picked files in bounded windows.
  streaming: true,
  // Extra library entries beyond the six images every test gets.
  extraAssets: [] as {
    id: string;
    kind: string;
    filename: string;
    screenshot: boolean;
    created_ms: number;
    mtime_ms: number;
  }[],
  // Asset ids whose export the fake shell refuses.
  exportFail: new Set<string>(),
  // The synced library as the ledger sees it.
  files: new Map<string, { sourceId?: string; trashed?: boolean }>(),
  // The path the fake network monitor reports; tests flip it to close
  // the Wi-Fi gate.
  network: {
    known: true,
    online: true,
    wifi: true,
    wired: false,
    cellular: false,
    expensive: false,
    constrained: false,
  },
}));

vi.mock("./backfill", () => ({
  scheduleBackfill: () => {
    rig.backfills++;
  },
}));

vi.mock("./native", () => ({
  nativePhotosAvailable: async () => true,
  nativeNetworkStatus: async () => ({ ...rig.network }),
  nativePhotosAuthorize: async () => "authorized",
  pickedStreamingAvailable: async () => rig.streaming,
  nativePhotosList: async () => [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `asset-${i}`,
      kind: "image",
      filename: `IMG_${i}.HEIC`,
      screenshot: false,
      created_ms: 1_754_700_000_000 + i,
      mtime_ms: 1_754_700_000_000 + i,
    })),
    ...rig.extraAssets,
  ],
  nativePhotoFile: async (id: string, name?: string) => {
    if (rig.exportFail.has(id)) {
      throw new Error("export failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new File([new Uint8Array(8)], name ?? `${id}.jpg`, { type: "image/jpeg" });
  },
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => ({
      session: { email: "t@example.com" },
      synced: true,
      serverSynced: rig.serverSynced,
      uploads: [],
      batch: null,
      files: rig.files,
      backedUpSourceIds: () =>
        new Set(
          [...rig.files.values()]
            .filter((f) => f.sourceId && !f.trashed)
            .map((f) => f.sourceId as string),
        ),
      backupAsset: async (file: File, sourceId: string) => {
        rig.running++;
        rig.peak = Math.max(rig.peak, rig.running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        rig.running--;
        rig.backedUp.push(sourceId);
        rig.fileNames.push(file.name);
        return sourceId;
      },
    }),
    setState: (patch: {
      batch?: { done: number; total: number; current: string } | null;
      batchStop?: (() => void) | null;
    }) => {
      if ("batch" in patch) {
        rig.batches.push(patch.batch ?? null);
      }
      if ("batchStop" in patch) {
        rig.stops.push(patch.batchStop);
      }
      if ("backupHold" in patch) {
        rig.holds.push(
          (patch as { backupHold?: "wifi" | "shell-videos" | null }).backupHold ?? null,
        );
      }
    },
  },
}));

vi.mock("./analysisslot", () => ({
  uploadLanes: () => 2,
}));

import {
  DEFAULT_POLICY,
  autoBackupPass,
  forgetBackupFailures,
  loadPolicy,
  runBackup,
  savePolicy,
  stopAutoBackup,
  windowStartMs,
} from "./backup";
import { resetBackupLedger } from "./backupledger";

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

// The ledger and failure memory persist by design; between tests that
// permanence is just leakage.
beforeEach(() => {
  localStorage.clear();
  rig.running = 0;
  rig.peak = 0;
  rig.backedUp.length = 0;
  rig.fileNames.length = 0;
  rig.serverSynced = true;
  rig.streaming = true;
  rig.extraAssets = [];
  rig.exportFail.clear();
  rig.files = new Map();
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
    expect(progress).toEqual({
      done: 6,
      total: 6,
      failed: 0,
      skipped: 0,
      current: expect.any(String),
    });
    expect(rig.backedUp).toHaveLength(6);
    expect(rig.peak).toBe(2);
    // One initial report, then two per photo (name known, then done),
    // done never decreasing.
    expect(seen).toHaveLength(13);
    expect(seen[0]).toBe(0);
    expect(seen[12]).toBe(6);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
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
    expect(progress!.done).toBeLessThan(6);
  });
});

/**
 * Backup used to run only when someone pressed the button in Profile.
 * The automatic pass runs when the app opens or returns to the
 * foreground, with a cooldown so focus-flapping does not re-list the
 * photo library every few seconds, and it narrates itself through the
 * shared batch pill so the upload activity is visible anywhere.
 */
describe("autoBackupPass", () => {
  it("does nothing while backup is turned off", async () => {
    localStorage.clear();
    rig.batches.length = 0;
    expect(await autoBackupPass(5_000_000)).toBeNull();
    expect(rig.batches).toEqual([]);
  });

  it("runs when enabled, narrates the batch pill, and schedules the backfill", async () => {
    savePolicy({ ...DEFAULT_POLICY, enabled: true });
    rig.batches.length = 0;
    rig.backfills = 0;
    const progress = await autoBackupPass(10_000_000);
    expect(progress?.done).toBe(6);
    // The pill saw real progress with real names, then cleared.
    expect(rig.batches.length).toBeGreaterThan(1);
    // The pill shows the photo's own library name, not the export path.
    expect(rig.batches.some((b) => b?.total === 6 && /IMG_\d\.HEIC/.test(b.current))).toBe(true);
    expect(rig.batches[rig.batches.length - 1]).toBeNull();
    expect(rig.backfills).toBe(1);
  });

  it("cools down between passes", async () => {
    savePolicy({ ...DEFAULT_POLICY, enabled: true });
    expect(await autoBackupPass(10_060_000)).toBeNull();
    expect(await autoBackupPass(10_000_000 + 11 * 60_000)).not.toBeNull();
    localStorage.clear();
  });

  it("holds on a metered connection, visibly, without spending the cooldown", async () => {
    savePolicy({ ...DEFAULT_POLICY, enabled: true });
    rig.holds.length = 0;
    rig.network = { ...rig.network, wifi: false, cellular: true };
    try {
      expect(await autoBackupPass(50_000_000)).toBeNull();
      expect(rig.holds[rig.holds.length - 1]).toBe("wifi");
    } finally {
      rig.network = { ...rig.network, wifi: true, cellular: false };
    }
    // The same moment retries clean: the skip burned no cooldown, and
    // the hold clears when the pass actually runs.
    const progress = await autoBackupPass(50_000_000);
    expect(progress?.done).toBe(6);
    expect(rig.holds[rig.holds.length - 1]).toBeNull();
    localStorage.clear();
  });

  it("offers a stop that halts the pass and hands the store the control", async () => {
    savePolicy({ ...DEFAULT_POLICY, enabled: true });
    rig.batches.length = 0;
    rig.backedUp.length = 0;
    rig.stops.length = 0;
    const pass = autoBackupPass(100_000_000);
    // Stop as soon as the first photo reports; in-flight lanes finish,
    // the rest are never taken up.
    await vi.waitFor(() => {
      if (rig.batches.length === 0) {
        throw new Error("not started");
      }
    });
    stopAutoBackup();
    const progress = await pass;
    expect(progress).not.toBeNull();
    expect(progress!.done).toBeLessThan(6);
    // The pill got a working stop control and both cleared at the end.
    expect(rig.stops.some((s) => typeof s === "function")).toBe(true);
    expect(rig.stops[rig.stops.length - 1]).toBeNull();
    expect(rig.batches[rig.batches.length - 1]).toBeNull();
    localStorage.clear();
  });
});

/**
 * The re-pick loop had four independent causes: trashed rows re-arming
 * their assets, failed exports retried forever, passes racing their own
 * guard, and passes reading a ledger the network had not filled yet.
 * Each gets its own test so a regression names itself.
 */
describe("backup dedupe and failure memory", () => {
  const enabled = { ...DEFAULT_POLICY, enabled: true };

  it("does not re-upload a photo whose vault copy is trashed", async () => {
    rig.files.set("f1", { sourceId: "asset-0", trashed: true });
    const progress = await runBackup(enabled);
    expect(progress?.done).toBe(5);
    expect(rig.backedUp).not.toContain("asset-0");
  });

  it("remembers deleted-forever uploads and leaves them alone", async () => {
    await runBackup(enabled);
    rig.backedUp.length = 0;
    // Deleting forever prunes the rows; only the ledger still knows.
    rig.files = new Map();
    const progress = await runBackup(enabled);
    expect(progress?.done).toBe(0);
    expect(rig.backedUp).toEqual([]);
  });

  it("backs deleted photos up again after a history reset", async () => {
    await runBackup(enabled);
    rig.backedUp.length = 0;
    resetBackupLedger("t@example.com");
    const progress = await runBackup(enabled);
    expect(progress?.done).toBe(6);
  });

  it("stops retrying an export that keeps failing, and says so", async () => {
    rig.exportFail.add("asset-3");
    for (let i = 0; i < 3; i++) {
      const p = await runBackup(enabled);
      expect(p?.failed).toBe(1);
    }
    const after = await runBackup(enabled);
    expect(after?.failed).toBe(0);
    expect(after?.skipped).toBe(1);
  });

  it("retries an exhausted export after an explicit clear", async () => {
    rig.exportFail.add("asset-3");
    for (let i = 0; i < 3; i++) {
      await runBackup(enabled);
    }
    rig.exportFail.clear();
    rig.backedUp.length = 0;
    // The budget is spent; a healthy export changes nothing by itself.
    expect((await runBackup(enabled))?.done).toBe(0);
    forgetBackupFailures("t@example.com");
    expect((await runBackup(enabled))?.done).toBe(1);
    expect(rig.backedUp).toContain("asset-3");
  });

  it("names backups after the photo library's own filename", async () => {
    await runBackup(enabled);
    expect(rig.fileNames).toContain("IMG_0.HEIC");
  });

  it("refuses a second pass while one is running", async () => {
    const [a, b] = await Promise.all([runBackup(enabled), runBackup(enabled)]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(rig.backedUp).toHaveLength(6);
  });

  it("waits for a real server sync before an automatic pass", async () => {
    savePolicy(enabled);
    rig.serverSynced = false;
    expect(await autoBackupPass(200_000_000)).toBeNull();
    rig.serverSynced = true;
    expect(await autoBackupPass(200_000_000)).not.toBeNull();
  });

  it("holds videos back, visibly, when the shell can only read files whole", async () => {
    // Reading a video whole through the bridge is the memory kill; until
    // the shell can stream, videos wait, and the wait is shown, not
    // burned as failed attempts.
    rig.streaming = false;
    rig.extraAssets = [
      {
        id: "vid-1",
        kind: "video",
        filename: "IMG_9.MOV",
        screenshot: false,
        created_ms: 1_754_700_000_100,
        mtime_ms: 1_754_700_000_100,
      },
    ];
    const held = await runBackup({ ...DEFAULT_POLICY, enabled: true, includeVideos: true });
    expect(held?.total).toBe(6);
    expect(rig.backedUp).not.toContain("vid-1");
    expect(rig.holds[rig.holds.length - 1]).toBe("shell-videos");

    rig.streaming = true;
    const caughtUp = await runBackup({ ...DEFAULT_POLICY, enabled: true, includeVideos: true });
    expect(caughtUp?.done).toBe(1);
    expect(rig.backedUp).toContain("vid-1");
    expect(rig.holds[rig.holds.length - 1]).toBeNull();
  });

  it("starts exactly one pass when foreground events double-fire", async () => {
    savePolicy(enabled);
    const [a, b] = await Promise.all([autoBackupPass(300_000_000), autoBackupPass(300_000_000)]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(rig.backedUp).toHaveLength(6);
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
