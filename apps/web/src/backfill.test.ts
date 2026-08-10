import { afterEach, describe, expect, it, vi } from "vitest";

const knobs = vi.hoisted(() => ({
  ocr: true,
  semantic: true,
  facts: true,
  handheld: false,
}));

vi.mock("./intel/ocr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/ocr")>()),
  ocrEnabled: () => knobs.ocr,
}));
vi.mock("./intel/semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/semantic")>()),
  semanticEnabled: () => knobs.semantic,
}));
vi.mock("./intel/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intel/scan")>()),
  factsEnabled: () => knobs.facts,
}));
vi.mock("./analysisslot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analysisslot")>()),
  isHandheld: () => knobs.handheld,
}));

import {
  HANDHELD_AUTO_MAX_BYTES,
  autoBackfillEnabled,
  backfillDelayMs,
  runBackfill,
  scheduleBackfill,
  setAutoBackfillEnabled,
  stopBackfill,
} from "./backfill";
import { useStore } from "./store";

// The preference lives in localStorage; give the node test env one.
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

const session = {
  email: "t@example.com",
  token: "t",
  masterKey: new Uint8Array(32),
  privateKey: new Uint8Array(32),
  publicKey: "",
};

interface SweepCall {
  skip?: Set<string>;
  maxBytes?: number;
  stop?: () => boolean;
}

/** Replaces every sweep with a recorder so runs are observable. */
const install = () => {
  const calls = {
    thumbs: [] as SweepCall[],
    ocr: [] as SweepCall[],
    clip: [] as SweepCall[],
    facts: [] as SweepCall[],
  };
  useStore.setState({
    session,
    synced: true,
    uploads: [],
    backfillThumbnails: async (o?: SweepCall) => {
      calls.thumbs.push(o ?? {});
      return 1;
    },
    recognizeAllImages: async (o?: SweepCall) => {
      calls.ocr.push(o ?? {});
      return 2;
    },
    embedAllImages: async (o?: SweepCall) => {
      calls.clip.push(o ?? {});
      return 3;
    },
    scanLibraryForFacts: async (o?: SweepCall) => {
      calls.facts.push(o ?? {});
      return 4;
    },
  });
  return calls;
};

afterEach(() => {
  knobs.ocr = true;
  knobs.semantic = true;
  knobs.facts = true;
  knobs.handheld = false;
  localStorage.clear();
  vi.useRealTimers();
});

describe("the automatic backfill can be declined and stopped", () => {
  it("is on by default and obeys the preference", async () => {
    expect(autoBackfillEnabled()).toBe(true);
    const calls = install();
    setAutoBackfillEnabled(false);
    expect(autoBackfillEnabled()).toBe(false);
    expect(await runBackfill()).toBeNull();
    expect(calls.thumbs).toHaveLength(0);
    setAutoBackfillEnabled(true);
    expect(await runBackfill()).not.toBeNull();
  });

  it("hands every sweep a stop probe and halts between passes once told", async () => {
    const calls = install();
    useStore.setState({
      backfillThumbnails: async (o?: SweepCall) => {
        calls.thumbs.push(o ?? {});
        expect(o?.stop?.()).toBe(false);
        stopBackfill();
        expect(o?.stop?.()).toBe(true);
        return 1;
      },
    });
    const stopped = await runBackfill();
    expect(stopped).toEqual({ thumbs: 1, text: 0, meaning: 0, facts: 0 });
    expect(calls.ocr).toHaveLength(0);
    expect(calls.clip).toHaveLength(0);
    expect(calls.facts).toHaveLength(0);
    // The stop is one pass's decision, not a permanent switch.
    install();
    expect(await runBackfill()).not.toBeNull();
  });
});

describe("backfillDelayMs", () => {
  it("starts a desktop promptly and holds a phone back with jitter", () => {
    expect(backfillDelayMs(false)).toBeLessThan(10_000);
    expect(backfillDelayMs(true, () => 0)).toBe(90_000);
    expect(backfillDelayMs(true, () => 0.999)).toBeLessThan(120_000);
    expect(backfillDelayMs(true, () => 0.999)).toBeGreaterThan(90_000);
  });
});

describe("runBackfill", () => {
  it("runs every pass, each with its own remembered attempts, uncapped on desktop", async () => {
    const calls = install();
    const first = await runBackfill();
    expect(first).toEqual({ thumbs: 1, text: 2, meaning: 3, facts: 4 });
    expect(calls.thumbs[0]!.skip).toBeInstanceOf(Set);
    expect(calls.thumbs[0]!.maxBytes).toBeUndefined();
    expect(calls.ocr[0]!.skip).toBeInstanceOf(Set);
    // Attempts are remembered per pass, not shared between passes.
    expect(calls.thumbs[0]!.skip).not.toBe(calls.ocr[0]!.skip);

    await runBackfill();
    // The same session-long memory rides into the next run.
    expect(calls.thumbs[1]!.skip).toBe(calls.thumbs[0]!.skip);
    expect(calls.facts[1]!.skip).toBe(calls.facts[0]!.skip);
  });

  it("leaves a scanner off when its preference is off", async () => {
    const calls = install();
    knobs.ocr = false;
    knobs.semantic = false;
    knobs.facts = false;
    const result = await runBackfill();
    expect(result).toEqual({ thumbs: 1, text: 0, meaning: 0, facts: 0 });
    expect(calls.ocr).toHaveLength(0);
    expect(calls.clip).toHaveLength(0);
    expect(calls.facts).toHaveLength(0);
  });

  it("caps the auto pass to modest files on a handheld", async () => {
    const calls = install();
    knobs.handheld = true;
    await runBackfill();
    expect(calls.thumbs[0]!.maxBytes).toBe(HANDHELD_AUTO_MAX_BYTES);
  });

  it("does nothing signed out, before sync, or while an upload is running", async () => {
    const calls = install();
    useStore.setState({ session: null });
    expect(await runBackfill()).toBeNull();
    useStore.setState({ session, synced: false });
    expect(await runBackfill()).toBeNull();
    useStore.setState({
      synced: true,
      uploads: [{ id: "u1", name: "a.jpg", progress: 0, status: "uploading" }],
    });
    expect(await runBackfill()).toBeNull();
    expect(calls.thumbs).toHaveLength(0);
  });

  it("runs once at a time", async () => {
    const calls = install();
    let release = () => {};
    useStore.setState({
      backfillThumbnails: async (o?: SweepCall) => {
        calls.thumbs.push(o ?? {});
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 1;
      },
    });
    const first = runBackfill();
    expect(await runBackfill()).toBeNull();
    release();
    expect(await first).not.toBeNull();
    expect(calls.thumbs).toHaveLength(1);
  });
});

describe("scheduleBackfill", () => {
  it("coalesces requests and fires one run after the device's delay", async () => {
    vi.useFakeTimers();
    const calls = install();
    scheduleBackfill();
    scheduleBackfill();
    scheduleBackfill();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.thumbs).toHaveLength(1);
  });
});
