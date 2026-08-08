import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, savePolicy, windowStartMs } from "./backup";

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
