import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyDecisions,
  clearDecisions,
  decide,
  decided,
  DECISIONS_EVENT,
  decisionEvents,
  loadDecisions,
  mergeDecisions,
  pinned,
  recentSearches,
  rememberSearch,
  setPin,
  type Decisions,
} from "./decisions";

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

const account = "d@example.com";

/**
 * What the user decided about the library (a notice dismissed, a trip
 * refused, a notice read, a search made) is the account's, not one
 * device's. These sets ride the sealed settings blob and merge by
 * union, so a decision made anywhere holds everywhere and nothing
 * dismissed comes back because another device had not heard yet.
 */
describe("account decisions", () => {
  it("remembers a decision per account and keeps accounts apart", () => {
    decide(account, "dismissedInsights", ["dup:abc"]);
    expect(decided(account, "dismissedInsights").has("dup:abc")).toBe(true);
    expect(decided("other@example.com", "dismissedInsights").size).toBe(0);
  });

  it("announces every change so open views re-read", () => {
    let fired = 0;
    const bump = () => (fired += 1);
    decisionEvents.addEventListener(DECISIONS_EVENT, bump);
    decide(account, "noticesSeen", ["fact:f1:a"]);
    decisionEvents.removeEventListener(DECISIONS_EVENT, bump);
    expect(fired).toBe(1);
  });

  it("merges by union and reports whether this device knew more", () => {
    const local: Decisions = {
      dismissedInsights: ["a", "b"],
      dismissedTrips: [],
      noticesSeen: ["n1"],
      recentSearches: [{ q: "tax", at: 10 }],
    };
    const remote: Decisions = {
      dismissedInsights: ["b", "c"],
      dismissedTrips: ["t1"],
      noticesSeen: ["n1"],
      recentSearches: [{ q: "tax", at: 5 }, { q: "lease", at: 8 }],
    };
    const { merged, localKnewMore } = mergeDecisions(local, remote);
    expect([...merged.dismissedInsights].sort()).toEqual(["a", "b", "c"]);
    expect(merged.dismissedTrips).toEqual(["t1"]);
    expect(merged.noticesSeen).toEqual(["n1"]);
    // Newest first, one entry per query, the newer time kept.
    expect(merged.recentSearches).toEqual([{ q: "tax", at: 10 }, { q: "lease", at: 8 }]);
    expect(localKnewMore).toBe(true);
    expect(mergeDecisions(remote, merged).localKnewMore).toBe(false);
  });

  it("applies a remote blob as a union, never as an overwrite", () => {
    decide(account, "dismissedTrips", ["trip:paris-2026-05"]);
    const knewMore = applyDecisions(account, {
      dismissedInsights: ["dup:zzz"],
      dismissedTrips: [],
      noticesSeen: [],
      recentSearches: [],
    });
    expect(decided(account, "dismissedTrips").has("trip:paris-2026-05")).toBe(true);
    expect(decided(account, "dismissedInsights").has("dup:zzz")).toBe(true);
    expect(knewMore).toBe(true);
  });

  it("keeps recent searches newest first and capped", () => {
    for (let i = 0; i < 10; i += 1) {
      rememberSearch(account, `query ${i}`, i);
    }
    rememberSearch(account, "query 3", 100);
    const recents = recentSearches(account);
    expect(recents[0]).toBe("query 3");
    expect(recents).toHaveLength(6);
    expect(new Set(recents).size).toBe(recents.length);
  });

  it("caps each set to its newest entries", () => {
    const keys = Array.from({ length: 1_205 }, (_, i) => `k${i}`);
    decide(account, "noticesSeen", keys);
    const seen = decided(account, "noticesSeen");
    expect(seen.size).toBe(500);
    expect(seen.has("k1204")).toBe(true);
    expect(seen.has("k0")).toBe(false);
  });

  it("adopts what the device remembered before decisions followed the account", () => {
    localStorage.setItem(`engram-notices-seen:${account}`, JSON.stringify(["fact:f1:a"]));
    localStorage.setItem("engram-trips-dismissed", JSON.stringify(["trip:rome-2025-09"]));
    localStorage.setItem("engram-recent-searches", JSON.stringify(["invoice", "photos of food"]));
    const loaded = loadDecisions(account);
    expect(loaded.noticesSeen).toEqual(["fact:f1:a"]);
    expect(loaded.dismissedTrips).toEqual(["trip:rome-2025-09"]);
    expect(loaded.recentSearches.map((r) => r.q)).toEqual(["invoice", "photos of food"]);
    // Taken over once; the old records are gone.
    expect(localStorage.getItem(`engram-notices-seen:${account}`)).toBeNull();
    expect(localStorage.getItem("engram-trips-dismissed")).toBeNull();
    expect(localStorage.getItem("engram-recent-searches")).toBeNull();
  });

  it("keeps pins as the account's, and the newest word on a pin wins across devices", () => {
    setPin(account, "album:alps", true, 10);
    expect(pinned(account).has("album:alps")).toBe(true);
    setPin(account, "album:alps", false, 20);
    expect(pinned(account).has("album:alps")).toBe(false);
    // Another device pinned it later than this device unpinned it.
    const knewMore = applyDecisions(account, {
      dismissedInsights: [],
      dismissedTrips: [],
      noticesSeen: [],
      recentSearches: [],
      pins: { "album:alps": { on: true, at: 30 }, "album:coast": { on: true, at: 5 } },
    });
    expect([...pinned(account)].sort()).toEqual(["album:alps", "album:coast"]);
    expect(knewMore).toBe(false);
    // A pin this device made that the account has not heard of is news.
    setPin(account, "album:zurich", true, 40);
    expect(
      applyDecisions(account, {
        dismissedInsights: [],
        dismissedTrips: [],
        noticesSeen: [],
        recentSearches: [],
        pins: { "album:alps": { on: true, at: 30 } },
      }),
    ).toBe(true);
  });

  it("forgets the device's copy at sign-out", () => {
    decide(account, "dismissedInsights", ["a"]);
    rememberSearch(account, "secret project", 1);
    clearDecisions(account);
    expect(decided(account, "dismissedInsights").size).toBe(0);
    expect(recentSearches(account)).toEqual([]);
  });
});
