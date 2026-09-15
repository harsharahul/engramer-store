import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_LIMIT,
  describeProcessing,
  loadActivityLog,
  saveActivityLog,
  unreadCount,
  withEntry,
  type ActivityEntry,
} from "./activity";

const entry = (id: string, unread = true): ActivityEntry => ({
  id,
  at: Number(id),
  kind: "processing",
  title: `t${id}`,
  unread,
});

// The log lives in localStorage; give the node test environment one.
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

describe("the activity log", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the newest first and never more than the cap", () => {
    let log: ActivityEntry[] = [];
    for (let i = 0; i < ACTIVITY_LOG_LIMIT + 5; i++) {
      log = withEntry(log, entry(String(i)));
    }
    expect(log).toHaveLength(ACTIVITY_LOG_LIMIT);
    expect(log[0]!.id).toBe(String(ACTIVITY_LOG_LIMIT + 4));
  });

  it("survives a reload per account and counts what is unread", () => {
    const log = withEntry(withEntry([], entry("1")), entry("2", false));
    saveActivityLog("a@example.com", log);
    expect(loadActivityLog("a@example.com")).toEqual(log);
    expect(loadActivityLog("b@example.com")).toEqual([]);
    expect(unreadCount(log)).toBe(1);
  });
});

describe("describeProcessing", () => {
  it("counts only what landed, names failures, and says when it stopped", () => {
    expect(
      describeProcessing({
        files: 500,
        previews: 500,
        text: 118,
        meaning: 500,
        tagged: 500,
        facts: 0,
        summaries: 0,
        summaryPaused: 0,
        failed: ["a.jpg", "b.jpg"],
        stopped: false,
        remaining: 0,
      }),
    ).toEqual({
      title: "Processed 500 files",
      detail: "500 previews · 118 with text · 500 by meaning · 500 tagged · 2 could not be processed: a.jpg, b.jpg",
    });
    expect(
      describeProcessing({
        files: 213,
        previews: 213,
        text: 0,
        meaning: 213,
        tagged: 213,
        facts: 0,
        summaries: 0,
        summaryPaused: 0,
        failed: [],
        stopped: true,
        remaining: 287,
      }),
    ).toEqual({
      title: "Stopped after 213 of 500",
      detail: "213 previews · 213 by meaning · 213 tagged · continues next time the app is open",
    });
    expect(
      describeProcessing({
        files: 0,
        previews: 0,
        text: 0,
        meaning: 0,
        tagged: 0,
        facts: 0,
        summaries: 0,
        summaryPaused: 0,
        failed: [],
        stopped: false,
        remaining: 0,
      }),
    ).toEqual({ title: "Nothing to fill in" });
  });
});

describe("describeProcessing with the assistant", () => {
  it("counts summaries and says when the model would not read in the background", () => {
    const described = describeProcessing({
      files: 12,
      previews: 0,
      text: 0,
      meaning: 0,
      tagged: 0,
      facts: 0,
      summaries: 9,
      summaryPaused: 3,
      failed: [],
      stopped: false,
      remaining: 0,
    });
    expect(described.title).toBe("Processed 12 files");
    expect(described.detail).toBe("9 summarized · 3 summaries wait for the app to be in front");
  });
});
