import { describe, expect, it } from "vitest";
import { duplicatesByDigest } from "./duplicates";

const f = (id: string, digest?: string, over: { trashed?: boolean; createdAt?: number } = {}) => ({
  id,
  digest,
  trashed: over.trashed ?? false,
  createdAt: over.createdAt ?? 0,
});

describe("duplicatesByDigest", () => {
  it("groups files whose contents are byte for byte identical", () => {
    const groups = duplicatesByDigest([f("a", "d1"), f("b", "d1"), f("c", "d2")]);
    expect(groups).toEqual([{ digest: "d1", fileIds: ["a", "b"] }]);
  });

  it("says nothing about a file that is alone", () => {
    expect(duplicatesByDigest([f("a", "d1")])).toEqual([]);
  });

  it("ignores files with no digest rather than grouping them by its absence", () => {
    expect(duplicatesByDigest([f("a"), f("b")])).toEqual([]);
  });

  it("leaves trashed files out", () => {
    expect(duplicatesByDigest([f("a", "d1"), f("b", "d1", { trashed: true })])).toEqual([]);
  });

  it("puts the oldest copy first, so the original is the one kept by default", () => {
    const groups = duplicatesByDigest([
      f("new", "d1", { createdAt: 200 }),
      f("old", "d1", { createdAt: 100 }),
    ]);
    expect(groups[0]!.fileIds).toEqual(["old", "new"]);
  });

  it("finds several groups at once", () => {
    const groups = duplicatesByDigest([
      f("a", "d1"),
      f("b", "d1"),
      f("c", "d2"),
      f("d", "d2"),
      f("e", "d3"),
    ]);
    expect(groups.map((g) => g.digest).sort()).toEqual(["d1", "d2"]);
  });

  it("says nothing about an empty library", () => {
    expect(duplicatesByDigest([])).toEqual([]);
  });
});
