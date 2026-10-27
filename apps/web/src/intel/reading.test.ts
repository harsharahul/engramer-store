import { describe, expect, it } from "vitest";
import type { ReadingStamp } from "@engramer/crypto";
import { legacyOf, needsReading, stampInto, stampOf, type ReadingCandidate } from "./reading";

const NOW = Date.UTC(2027, 5, 1);
const DAY = 86_400_000;

const file = (over: Partial<ReadingCandidate> = {}): ReadingCandidate => ({
  trashed: false,
  mime: "application/pdf",
  hasText: true,
  inlineText: false,
  digest: "d1",
  createdAt: NOW - 400 * DAY,
  ...over,
});

const stamp = (over: Partial<ReadingStamp> = {}): ReadingStamp => ({
  reader: "apple",
  rank: 2,
  version: 1,
  digest: "d1",
  tasks: ["summary", "facts"],
  outcome: "found",
  tries: 1,
  at: NOW - 30 * DAY,
  ...over,
});

const wants = { factsWanted: true, now: NOW };

describe("needsReading", () => {
  it("reads a document no reader has read", () => {
    expect(needsReading(file(), "apple", wants)).toBe(true);
  });

  it("a file read by an older build is not read again", () => {
    // Builds before the stamp wrote only these two fields.
    expect(needsReading(file({ assistVersion: 1 }), "apple", wants)).toBe(false);
    expect(needsReading(file({ assistVersion: 1, noSummary: "short" }), "apple", wants)).toBe(false);
    expect(stampOf(file({ assistVersion: 1, noSummary: "declined" }))).toMatchObject({
      reader: "apple",
      rank: 2,
      version: 1,
      outcome: "declined",
    });
  });

  it("a changed digest asks for one new read", () => {
    expect(needsReading(file({ digest: "d2", reading: stamp() }), "apple", wants)).toBe(true);
    expect(needsReading(file({ reading: stamp() }), "apple", wants)).toBe(false);
  });

  it("a weaker reader never reads after a stronger one, even when it found nothing", () => {
    const stronger = stamp({ reader: "mac-large", rank: 1, outcome: "none" });
    expect(needsReading(file({ reading: stronger }), "apple", wants)).toBe(false);
    // New contents are a new item: whichever reader is here reads them.
    expect(needsReading(file({ digest: "d2", reading: stronger }), "apple", wants)).toBe(true);
  });

  it("facts turned on reads a file once more for facts only", () => {
    expect(needsReading(file({ reading: stamp({ tasks: ["summary"] }) }), "apple", wants)).toBe(true);
    expect(needsReading(file({ reading: stamp({ tasks: ["summary"] }) }), "apple", { ...wants, factsWanted: false })).toBe(false);
  });

  it("a failed or owner-removed reading is never re-read", () => {
    expect(needsReading(file({ digest: "d2", reading: stamp({ outcome: "failed", tries: 3 }) }), "apple", wants)).toBe(false);
    expect(needsReading(file({ digest: "d2", reading: stamp({ outcome: "user" }) }), "apple", wants)).toBe(false);
  });

  it("a new reader version re-reads only empty answers and recent files", () => {
    const older = (over: Partial<ReadingStamp>) => stamp({ version: 0, ...over });
    expect(needsReading(file({ reading: older({ outcome: "found" }) }), "apple", wants)).toBe(false);
    expect(needsReading(file({ reading: older({ outcome: "none" }) }), "apple", wants)).toBe(true);
    expect(needsReading(file({ reading: older({ outcome: "declined" }) }), "apple", wants)).toBe(true);
    expect(needsReading(file({ createdAt: NOW - 10 * DAY, reading: older({ outcome: "found" }) }), "apple", wants)).toBe(true);
  });

  it("never reads media, a file with no text, or the trash", () => {
    expect(needsReading(file({ mime: "image/jpeg" }), "apple", wants)).toBe(false);
    expect(needsReading(file({ hasText: false }), "apple", wants)).toBe(false);
    expect(needsReading(file({ trashed: true }), "apple", wants)).toBe(false);
    // A legacy row that still keeps its text inside its metadata is readable.
    expect(needsReading(file({ hasText: false, inlineText: true }), "apple", wants)).toBe(true);
  });
});

describe("stamps that older builds understand", () => {
  it("an older build sees a newly stamped file as read", () => {
    expect(legacyOf(stamp({ outcome: "found" }))).toEqual({ assistVersion: 1 });
    expect(legacyOf(stamp({ outcome: "short" }))).toEqual({ assistVersion: 1, noSummary: "short" });
    expect(legacyOf(stamp({ outcome: "failed", tries: 3 }))).toEqual({ assistVersion: 1, noSummary: "failed" });
  });

  it("stampInto writes the stamp and the legacy pair together", () => {
    const meta: { reading?: ReadingStamp; assistVersion?: number; noSummary?: string } = { noSummary: "short" };
    stampInto(meta, stamp({ outcome: "found" }));
    expect(meta.reading?.outcome).toBe("found");
    expect(meta.assistVersion).toBe(1);
    expect(meta).toHaveProperty("noSummary", undefined);
  });
});
