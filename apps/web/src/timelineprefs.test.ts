import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { homeCity, openOn, setHomeCity, setOpenOn } from "./timelineprefs";

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

describe("the Timeline's settings", () => {
  it("home city is trimmed and capped, and empty clears it", () => {
    expect(homeCity()).toBeUndefined();
    setHomeCity("  Lisbon  ");
    expect(homeCity()).toBe("Lisbon");
    setHomeCity("x".repeat(100));
    expect(homeCity()).toHaveLength(80);
    setHomeCity("   ");
    expect(homeCity()).toBeUndefined();
  });

  it("open on defaults to the timeline", () => {
    expect(openOn()).toBe("timeline");
    setOpenOn("files");
    expect(openOn()).toBe("files");
    setOpenOn("timeline");
    expect(openOn()).toBe("timeline");
  });
});
