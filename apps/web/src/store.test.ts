import { describe, expect, it } from "vitest";
import { metadataOf, type FileEntry } from "./store";

/**
 * Metadata is rebuilt from the in-memory entry on every patch, so anything
 * metadataOf forgets is destroyed the next time a file is renamed, tagged or
 * favorited. These tests exist because that is silent: nothing fails, the file
 * still opens, and the loss is only visible much later when a check that
 * needed the missing field cannot run.
 */

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: "f1",
  folderId: null,
  name: "passport.pdf",
  mime: "application/pdf",
  size: 1024,
  mtime: 1_700_000_000_000,
  hasText: false,
  hasClip: false,
  inlineText: false,
  tags: ["documents"],
  facts: [],
  favorite: false,
  key: new Uint8Array(32),
  hasThumb: false,
  trashed: false,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("metadataOf", () => {
  it("keeps the content digest, which a patch would otherwise erase", () => {
    const digest = "b1946ac92492d2347c6235b4d2611184";
    expect(metadataOf(entry({ digest })).digest).toBe(digest);
  });

  it("keeps the facts read out of the file", () => {
    const facts = [
      {
        id: "f1:expiry:2029-03-12",
        kind: "expiry" as const,
        document: "passport" as const,
        value: "2029-03-12",
        source: "mrz" as const,
        confidence: 1,
        confirmed: true,
      },
    ];
    expect(metadataOf(entry({ facts })).facts).toEqual(facts);
  });

  it("writes no facts field at all for a file that carries none", () => {
    expect(metadataOf(entry())).not.toHaveProperty("facts");
  });

  it("still carries the fields it always did", () => {
    const meta = metadataOf(entry({ category: "Documents", favorite: true }));
    expect(meta).toMatchObject({
      name: "passport.pdf",
      mime: "application/pdf",
      category: "Documents",
      tags: ["documents"],
      favorite: true,
    });
  });
});
