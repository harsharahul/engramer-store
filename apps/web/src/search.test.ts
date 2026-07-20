import { describe, expect, it } from "vitest";
import { parseQuery, searchFiles } from "./search";
import type { FileEntry, FolderEntry } from "./store";

function file(partial: Partial<FileEntry>): FileEntry {
  return {
    id: partial.id ?? crypto.randomUUID(),
    folderId: partial.folderId ?? null,
    name: partial.name ?? "file.txt",
    mime: partial.mime ?? "text/plain",
    size: 1,
    mtime: 0,
    tags: partial.tags ?? [],
    favorite: partial.favorite ?? false,
    text: partial.text,
    category: partial.category,
    key: new Uint8Array(),
    hasThumb: false,
    trashed: partial.trashed ?? false,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("parseQuery", () => {
  it("separates filters from free text", () => {
    const parsed = parseQuery("budget tag:receipts type:pdf in:Work is:favorite");
    expect(parsed.terms).toBe("budget");
    expect(parsed.tags).toEqual(["receipts"]);
    expect(parsed.types).toEqual(["pdf"]);
    expect(parsed.folder).toBe("work");
    expect(parsed.favorite).toBe(true);
  });
});

describe("searchFiles", () => {
  const folders = new Map<string, FolderEntry>([
    ["f1", { id: "f1", parentId: null, name: "Receipts", key: new Uint8Array(), createdAt: 0, updatedAt: 0 }],
  ]);

  it("finds by fuzzy name", () => {
    const files = [file({ name: "quarterly-report.pdf" }), file({ name: "cat.jpg" })];
    const hits = searchFiles(files, "report");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.name).toBe("quarterly-report.pdf");
  });

  it("finds by extracted content and returns a snippet", () => {
    const files = [file({ name: "notes.txt", text: "the codeword is ZEPHYR tonight" })];
    const hits = searchFiles(files, "zephyr");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchedText).toContain("ZEPHYR");
  });

  it("filters by tag", () => {
    const files = [
      file({ name: "a.pdf", tags: ["receipts", "invoice"] }),
      file({ name: "b.pdf", tags: ["documents"] }),
    ];
    expect(searchFiles(files, "tag:receipts")).toHaveLength(1);
  });

  it("filters by type and by favorite", () => {
    const files = [
      file({ name: "photo.jpg", mime: "image/jpeg", favorite: true }),
      file({ name: "doc.pdf", mime: "application/pdf" }),
    ];
    expect(searchFiles(files, "type:image")).toHaveLength(1);
    expect(searchFiles(files, "is:favorite")).toHaveLength(1);
    expect(searchFiles(files, "type:pdf")[0]!.file.name).toBe("doc.pdf");
  });

  it("filters by containing folder name", () => {
    const files = [
      file({ name: "march.pdf", folderId: "f1", tags: ["receipts"] }),
      file({ name: "loose.pdf" }),
    ];
    const hits = searchFiles(files, "in:receipts", folders);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.folderId).toBe("f1");
  });

  it("excludes trashed files", () => {
    const files = [file({ name: "gone.pdf", trashed: true })];
    expect(searchFiles(files, "gone")).toHaveLength(0);
  });
});
