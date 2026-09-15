import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DUE_DAYS,
  dueNotices,
  loadNotified,
  loadSeen,
  markNotified,
  markSeen,
  newDue,
  noticeKeys,
  unseenCount,
  type NoticeFile,
} from "./notices";
import type { Fact } from "./intel/facts";

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

const now = new Date(2026, 8, 10, 12).getTime();
const day = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(now + offsetDays * day).toISOString().slice(0, 10);

function fact(id: string, kind: Fact["kind"], value: string, extra: Partial<Fact> = {}): Fact {
  return {
    id,
    kind,
    document: "other",
    value,
    source: "label",
    confidence: 0.8,
    confirmed: true,
    ...extra,
  };
}

const files: NoticeFile[] = [
  { id: "f1", name: "insurance.pdf", digest: "d1", tags: [], facts: [fact("a", "expiry", iso(12))], trashed: false, createdAt: 1 },
  { id: "f2", name: "warranty.pdf", digest: "d2", tags: [], facts: [fact("b", "expiry", iso(90))], trashed: false, createdAt: 1 },
  { id: "f3", name: "invoice.pdf", digest: "d3", tags: [], facts: [fact("c", "due", iso(-3))], trashed: false, createdAt: 1 },
  { id: "f4", name: "old.pdf", digest: "d4", tags: [], facts: [fact("d", "expiry", iso(-400))], trashed: false, createdAt: 1 },
  { id: "f5", name: "gone.pdf", digest: "d5", tags: [], facts: [fact("e", "expiry", iso(2))], trashed: true, createdAt: 1 },
  { id: "f6", name: "copy-a.jpg", digest: "same", tags: [], facts: [], trashed: false, createdAt: 1 },
  { id: "f7", name: "copy-b.jpg", digest: "same", tags: [], facts: [], trashed: false, createdAt: 1 },
  { id: "f8", name: "pass.pdf", digest: "d8", tags: ["trip:rome"], facts: [], trashed: false, createdAt: 1 },
];

describe("noticeKeys", () => {
  it("names every item the notice center shows, stably", () => {
    const keys = noticeKeys(files, now);
    expect(keys).toContain("fact:f1:a");
    expect(keys).toContain("fact:f2:b");
    expect(keys).toContain("fact:f3:c");
    expect(keys).toContain("dup:same");
    expect(keys).toContain("trip:trip:rome");
    expect(keys).not.toContain("fact:f4:d");
    expect(keys).not.toContain("fact:f5:e");
    expect(noticeKeys(files, now)).toEqual(keys);
  });
});

describe("seen", () => {
  it("counts what the bell has not shown yet, per account, and remembers", () => {
    const keys = noticeKeys(files, now);
    expect(unseenCount(keys, loadSeen("a@example.com"))).toBe(keys.length);
    markSeen("a@example.com", keys);
    expect(unseenCount(keys, loadSeen("a@example.com"))).toBe(0);
    expect(unseenCount(keys, loadSeen("b@example.com"))).toBe(keys.length);
    expect(unseenCount([...keys, "fact:f9:z"], loadSeen("a@example.com"))).toBe(1);
  });
});

describe("dueNotices", () => {
  it("picks only dated items close enough to interrupt for, in words", () => {
    const due = dueNotices(files, now);
    const keys = due.map((n) => n.key);
    // The dated facts, soonest first; then whatever the rules noticed
    // about them that is worth an interruption (never an "info" one).
    expect(keys.slice(0, 2)).toEqual(["fact:f3:c", "fact:f1:a"]);
    for (const extra of due.slice(2)) {
      expect(extra.key.startsWith("insight:")).toBe(true);
      expect(["overdue", "soon"]).toContain(extra.severity);
    }
    expect(due[0]!.title).toMatch(/due/i);
    expect(due[0]!.body).toBe("invoice.pdf");
    expect(due[1]!.fileId).toBe("f1");
    expect(DUE_DAYS).toBe(30);
  });
});

describe("newDue and notified", () => {
  it("never repeats a notification for the same fact", () => {
    const due = dueNotices(files, now);
    expect(newDue(due, loadNotified("a@example.com"))).toHaveLength(due.length);
    markNotified("a@example.com", due.map((n) => n.key));
    expect(newDue(due, loadNotified("a@example.com"))).toHaveLength(0);
    expect(newDue(due, loadNotified("b@example.com"))).toHaveLength(due.length);
  });
});
