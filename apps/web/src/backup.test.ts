import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, savePolicy } from "./backup";

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
    savePolicy({ enabled: true, includeVideos: false, includeScreenshots: false, wifiOnly: false });
    expect(loadPolicy()).toEqual({
      enabled: true,
      includeVideos: false,
      includeScreenshots: false,
      wifiOnly: false,
    });
  });

  it("fills missing keys from the defaults for a forward-compatible stored blob", () => {
    localStorage.setItem("engram-backup-policy", JSON.stringify({ enabled: true }));
    const policy = loadPolicy();
    expect(policy.enabled).toBe(true);
    expect(policy.includeVideos).toBe(DEFAULT_POLICY.includeVideos);
  });
});
