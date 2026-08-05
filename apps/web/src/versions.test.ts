import { describe, expect, it } from "vitest";
import type { FileMetadata } from "@engramer/crypto";
import { mergeRestoredMeta } from "./versions";

describe("mergeRestoredMeta", () => {
  const current: FileMetadata = {
    name: "renamed-since.txt",
    mime: "text/plain",
    size: 999,
    mtime: 2000,
    text: "newer words",
    category: "Notes",
    tags: ["kept", "tags"],
    favorite: true,
  };
  const version: FileMetadata = {
    name: "old-name.txt",
    mime: "text/plain",
    size: 42,
    mtime: 1000,
    text: "original words",
    category: "Other",
    tags: ["stale"],
    favorite: false,
  };

  it("keeps organization from the present, content facts from the version", () => {
    const merged = mergeRestoredMeta(current, version);
    expect(merged.name).toBe("renamed-since.txt");
    expect(merged.tags).toEqual(["kept", "tags"]);
    expect(merged.favorite).toBe(true);
    expect(merged.category).toBe("Notes");
    expect(merged.size).toBe(42);
    expect(merged.mtime).toBe(1000);
    expect(merged.text).toBe("original words");
  });

  it("restores the facts the older contents carried, not the current ones", () => {
    // A tag is something the owner chose about the file; a fact is something
    // the file said. Restoring older contents has to restore what those
    // contents said, or the file would carry an expiry date that no version
    // of it ever contained.
    const merged = mergeRestoredMeta(
      {
        ...current,
        digest: "digest-of-newer",
        facts: [
          {
            id: "f:expiry:2030-01-01",
            kind: "expiry",
            document: "insurance",
            value: "2030-01-01",
            source: "label",
            confidence: 0.7,
            confirmed: true,
          },
        ],
      },
      {
        ...version,
        digest: "digest-of-older",
        facts: [
          {
            id: "f:expiry:2027-01-01",
            kind: "expiry",
            document: "insurance",
            value: "2027-01-01",
            source: "label",
            confidence: 0.7,
          },
        ],
      },
    );
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts![0]!.value).toBe("2027-01-01");
    expect(merged.digest).toBe("digest-of-older");
  });

  it("leaves a restored file with no facts when the version carried none", () => {
    const merged = mergeRestoredMeta(
      { ...current, facts: [{ id: "a", kind: "expiry", document: "other", value: "2030-01-01", source: "label", confidence: 0.7 }] },
      version,
    );
    expect(merged.facts).toBeUndefined();
  });
});
