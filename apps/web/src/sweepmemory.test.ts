import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SweepMemory, attemptCap } from "./sweepmemory";

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
 * A session on a phone is one app open. Remembering failures only for
 * that long means a file this device cannot process is re-downloaded and
 * re-attempted every single time the app opens, forever, which is exactly
 * what the owner saw. The memory has to outlive the session.
 */
describe("SweepMemory", () => {
  it("gives up on a file after the retry cap and says so across instances", () => {
    const memory = new SweepMemory("me@example.com", "thumbs");
    expect(memory.exhausted("f1")).toBe(false);
    for (let i = 0; i < attemptCap("thumbs"); i++) {
      memory.record("f1", false);
    }
    expect(memory.exhausted("f1")).toBe(true);
    // A fresh instance, standing in for the next app open, agrees.
    expect(new SweepMemory("me@example.com", "thumbs").exhausted("f1")).toBe(true);
  });

  it("forgets a file that eventually succeeds", () => {
    const memory = new SweepMemory("me@example.com", "text");
    memory.record("f1", false);
    memory.record("f1", true);
    expect(memory.exhausted("f1")).toBe(false);
    expect(new SweepMemory("me@example.com", "text").attempts("f1")).toBe(0);
  });

  it("keeps one account's memory out of another's", () => {
    new SweepMemory("me@example.com", "thumbs").record("f1", false);
    expect(new SweepMemory("other@example.com", "thumbs").attempts("f1")).toBe(0);
  });

  it("keeps each pass's memory separate", () => {
    new SweepMemory("me@example.com", "thumbs").record("f1", false);
    expect(new SweepMemory("me@example.com", "meaning").attempts("f1")).toBe(0);
  });

  /**
   * The dates pass rescans by design so a better reader can revisit old
   * documents. As an automatic per-open pass that means re-reading the
   * library forever, so one attempt per device is the automatic budget;
   * the palette command still rescans everything.
   */
  it("allows the dates pass a single automatic attempt", () => {
    expect(attemptCap("facts")).toBe(1);
    const memory = new SweepMemory("me@example.com", "facts");
    memory.record("f1", true);
    expect(memory.exhausted("f1")).toBe(true);
  });

  /**
   * A photo whose export fails (an unreadable original, a stalled iCloud
   * download) used to be re-attempted on every single pass, forever - the
   * re-pick loop. Backup rides the same per-device budget the sweeps use.
   */
  it("budgets backup exports like recoverable sweep work", () => {
    expect(attemptCap("backup")).toBe(3);
    const memory = new SweepMemory("me@example.com", "backup");
    memory.record("asset-1", false);
    expect(new SweepMemory("me@example.com", "backup").attempts("asset-1")).toBe(1);
  });

  it("forgets everything when asked, so a manual run retries the stubborn ones", () => {
    const memory = new SweepMemory("me@example.com", "thumbs");
    for (let i = 0; i < attemptCap("thumbs"); i++) {
      memory.record("f1", false);
    }
    memory.forgetAll();
    expect(memory.exhausted("f1")).toBe(false);
    expect(new SweepMemory("me@example.com", "thumbs").exhausted("f1")).toBe(false);
  });

  it("survives unreadable storage without taking the sweep down", () => {
    localStorage.setItem("engram-sweep-thumbs:me@example.com", "{not json");
    const memory = new SweepMemory("me@example.com", "thumbs");
    expect(memory.attempts("f1")).toBe(0);
    memory.record("f1", false);
    expect(memory.attempts("f1")).toBe(1);
  });
});
