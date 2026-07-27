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
});
