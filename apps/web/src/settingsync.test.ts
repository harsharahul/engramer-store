import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKey, ready } from "@engramer/crypto";

const rig = vi.hoisted(() => ({
  remote: { blob: null as string | null, updatedAt: 0 },
  puts: [] as string[],
}));

vi.mock("./api", () => ({
  api: {
    getSettings: async () => ({ ...rig.remote }),
    putSettings: async (blob: string) => {
      rig.puts.push(blob);
      rig.remote = { blob, updatedAt: rig.remote.updatedAt + 10 };
      return { updatedAt: rig.remote.updatedAt };
    },
  },
}));

import {
  applySettings,
  pullSettings,
  pushSettings,
  settingsEvents,
  snapshotSettings,
  SETTINGS_APPLIED_EVENT,
  type SyncedSettings,
} from "./settingsync";
import { ocrEnabled, setOcrEnabled } from "./intel/ocr";
import { semanticEnabled } from "./intel/semantic";
import { loadPolicy, savePolicy, DEFAULT_POLICY } from "./backuppolicy";

// Prefs live in localStorage; give the node test env one.
beforeAll(async () => {
  await ready();
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

beforeEach(() => {
  localStorage.clear();
  rig.remote = { blob: null, updatedAt: 0 };
  rig.puts.length = 0;
});

const account = "s@example.com";

/**
 * Preferences lived only in each device's local storage: the same
 * switches had to be flipped on every device, and again whenever iOS
 * evicted the storage. They now follow the account as one sealed blob;
 * the backup on/off switch stays per device, because it is bound to that
 * device's photo-library permission.
 */
describe("settings snapshot and apply", () => {
  it("round-trips every synced switch", () => {
    setOcrEnabled(true);
    savePolicy({ ...DEFAULT_POLICY, enabled: true, includeVideos: false, window: "30d" });
    const snapshot = snapshotSettings();
    localStorage.clear();
    expect(ocrEnabled()).toBe(false);
    applySettings(snapshot);
    expect(ocrEnabled()).toBe(true);
    expect(semanticEnabled()).toBe(false);
    expect(loadPolicy().includeVideos).toBe(false);
    expect(loadPolicy().window).toBe("30d");
  });

  it("never touches the device's backup on/off switch", () => {
    savePolicy({ ...DEFAULT_POLICY, enabled: true });
    const remote: SyncedSettings = { ...snapshotSettings(), backup: { ...snapshotSettings().backup } };
    savePolicy({ ...DEFAULT_POLICY, enabled: false });
    applySettings(remote);
    expect(loadPolicy().enabled).toBe(false);
  });
});

describe("pull and push", () => {
  it("seeds an account that has no settings yet from this device", async () => {
    setOcrEnabled(true);
    await pullSettings(account, generateKey());
    expect(rig.puts).toHaveLength(1);
    // Sealed, not readable: the server holds ciphertext.
    expect(rig.puts[0]).not.toContain("ocr");
  });

  it("applies a newer remote blob and remembers how far it read", async () => {
    const key = generateKey();
    setOcrEnabled(true);
    await pushSettings(account, key);
    const pushed = { ...rig.remote };
    setOcrEnabled(false);
    rig.remote = { ...pushed, updatedAt: pushed.updatedAt + 100 };
    await pullSettings(account, key);
    expect(ocrEnabled()).toBe(true);
    // The same blob again changes nothing and re-applies nothing.
    setOcrEnabled(false);
    await pullSettings(account, key);
    expect(ocrEnabled()).toBe(false);
  });

  it("leaves local settings alone when the remote is older than what was read", async () => {
    const key = generateKey();
    await pushSettings(account, key);
    setOcrEnabled(true);
    rig.remote = { ...rig.remote, updatedAt: 0 };
    await pullSettings(account, key);
    expect(ocrEnabled()).toBe(true);
  });

  it("announces an applied change so open views re-read their switches", async () => {
    const key = generateKey();
    setOcrEnabled(true);
    await pushSettings(account, key);
    setOcrEnabled(false);
    rig.remote = { ...rig.remote, updatedAt: rig.remote.updatedAt + 100 };
    let announced = 0;
    const listener = () => announced++;
    settingsEvents.addEventListener(SETTINGS_APPLIED_EVENT, listener);
    await pullSettings(account, key);
    settingsEvents.removeEventListener(SETTINGS_APPLIED_EVENT, listener);
    expect(announced).toBe(1);
  });
});
