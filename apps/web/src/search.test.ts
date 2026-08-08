import { describe, expect, it } from "vitest";
import { highlightParts, parseQuery, searchFiles, withinOneEdit } from "./search";
import type { FileEntry, FolderEntry } from "./store";

function file(partial: Partial<FileEntry>): FileEntry {
  return {
    id: partial.id ?? crypto.randomUUID(),
    folderId: partial.folderId ?? null,
    name: partial.name ?? "file.txt",
    mime: partial.mime ?? "text/plain",
    size: 1,
    mtime: partial.mtime ?? 0,
    tags: partial.tags ?? [],
    facts: partial.facts ?? [],
    favorite: partial.favorite ?? false,
    text: partial.text,
    hasClip: false,
    hasText: partial.text !== undefined,
    inlineText: partial.text !== undefined,
    category: partial.category,
    key: new Uint8Array(),
    hasThumb: false,
    trashed: partial.trashed ?? false,
    createdAt: 0,
    updatedAt: partial.updatedAt ?? 0,
  };
}

describe("parseQuery", () => {
  it("separates filters from free text", () => {
    const parsed = parseQuery("budget tag:receipts type:pdf in:Work is:favorite");
    expect(parsed.terms).toEqual(["budget"]);
    expect(parsed.tags).toEqual(["receipts"]);
    expect(parsed.types).toEqual(["pdf"]);
    expect(parsed.folder).toBe("work");
    expect(parsed.favorite).toBe(true);
  });

  it("parses date bounds at period edges", () => {
    const parsed = parseQuery("after:2025 before:2026-02");
    expect(new Date(parsed.after!).getFullYear()).toBe(2025);
    expect(new Date(parsed.after!).getMonth()).toBe(0);
    const before = new Date(parsed.before!);
    expect(before.getFullYear()).toBe(2026);
    expect(before.getMonth()).toBe(1);
    expect(before.getDate()).toBe(28);
  });

  it("maps type synonyms", () => {
    expect(parseQuery("type:photo").types).toEqual(["image"]);
    expect(parseQuery("type:word").types).toEqual(["doc"]);
  });
});

describe("searchFiles", () => {
  const folders = new Map<string, FolderEntry>([
    ["f1", { id: "f1", parentId: null, name: "Receipts", key: new Uint8Array(), createdAt: 0, updatedAt: 0 }],
    ["f2", { id: "f2", parentId: "f1", name: "Taxes 2025", key: new Uint8Array(), createdAt: 0, updatedAt: 0 }],
  ]);

  it("finds by fuzzy name", () => {
    const files = [file({ name: "quarterly-report.pdf" }), file({ name: "cat.jpg" })];
    const hits = searchFiles(files, "report");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.name).toBe("quarterly-report.pdf");
  });

  it("survives a one-letter typo in a term", () => {
    const files = [file({ name: "invoice-march.pdf" }), file({ name: "cat.jpg" })];
    const hits = searchFiles(files, "invoise");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.name).toBe("invoice-march.pdf");
  });

  it("requires every term to match somewhere", () => {
    const files = [
      file({ name: "invoice-march.pdf" }),
      file({ name: "invoice-april.pdf" }),
    ];
    const hits = searchFiles(files, "invoice march");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.name).toBe("invoice-march.pdf");
  });

  it("finds files by the folder they live in", () => {
    const files = [
      file({ name: "w2-form.pdf", folderId: "f2" }),
      file({ name: "loose.pdf" }),
    ];
    const hits = searchFiles(files, "taxes", folders);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file.name).toBe("w2-form.pdf");
    expect(hits[0]!.matchedFolder).toBe("taxes 2025");
  });

  it("searches ancestor folders, not just the direct parent", () => {
    const files = [file({ name: "w2-form.pdf", folderId: "f2" })];
    expect(searchFiles(files, "receipts", folders)).toHaveLength(1);
    expect(searchFiles(files, "in:receipts", folders)).toHaveLength(1);
  });

  it("finds by extracted content and returns highlight ranges", () => {
    const files = [file({ name: "notes.txt", text: "the codeword is ZEPHYR tonight" })];
    const hits = searchFiles(files, "zephyr");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchedText).toContain("ZEPHYR");
    const ranges = hits[0]!.textRanges;
    expect(ranges.length).toBeGreaterThan(0);
    const highlighted = hits[0]!.matchedText!.slice(ranges[0]!.start, ranges[0]!.end);
    expect(highlighted.toLowerCase()).toBe("zephyr");
  });

  it("ranks a name match above a content-only match", () => {
    const files = [
      file({ name: "zephyr-launch.md" }),
      file({ name: "meeting.md", text: "we discussed zephyr at length" }),
    ];
    const hits = searchFiles(files, "zephyr");
    expect(hits[0]!.file.name).toBe("zephyr-launch.md");
  });

  it("boosts fresher files between equal matches", () => {
    const now = Date.now();
    const files = [
      file({ id: "old", name: "plan.md", updatedAt: now - 90 * 86_400_000 }),
      file({ id: "new", name: "plan.md", updatedAt: now }),
    ];
    const hits = searchFiles(files, "plan");
    expect(hits[0]!.file.id).toBe("new");
  });

  it("applies date bounds against modification time", () => {
    const files = [
      file({ name: "old.pdf", mtime: new Date(2024, 5, 1).getTime() }),
      file({ name: "new.pdf", mtime: new Date(2026, 5, 1).getTime() }),
    ];
    expect(searchFiles(files, "before:2025")[0]!.file.name).toBe("old.pdf");
    expect(searchFiles(files, "after:2026")[0]!.file.name).toBe("new.pdf");
  });

  it("filters by tag, type, and favorite", () => {
    const files = [
      file({ name: "photo.jpg", mime: "image/jpeg", favorite: true, tags: ["receipts"] }),
      file({ name: "doc.pdf", mime: "application/pdf" }),
    ];
    expect(searchFiles(files, "tag:receipts")).toHaveLength(1);
    expect(searchFiles(files, "type:image")).toHaveLength(1);
    expect(searchFiles(files, "is:favorite")).toHaveLength(1);
    expect(searchFiles(files, "type:pdf")[0]!.file.name).toBe("doc.pdf");
  });

  it("matches reserved-namespace tags exactly, free tags by substring", () => {
    const files = [
      file({ name: "beach.jpg", tags: ["album:holidays-2026"] }),
      file({ name: "list.pdf", tags: ["holiday-shopping"] }),
    ];
    expect(searchFiles(files, "tag:album:holidays-2026")).toHaveLength(1);
    expect(searchFiles(files, "tag:album:holidays-2026")[0]!.file.name).toBe("beach.jpg");
    expect(searchFiles(files, "tag:album:holidays")).toHaveLength(0);
    const holiday = searchFiles(files, "tag:holiday");
    expect(holiday).toHaveLength(1);
    expect(holiday[0]!.file.name).toBe("list.pdf");
  });

  it("marks name match ranges on the original name", () => {
    const files = [file({ name: "Quarterly-Report.pdf" })];
    const hit = searchFiles(files, "report")[0]!;
    expect(hit.nameRanges).toHaveLength(1);
    const { start, end } = hit.nameRanges[0]!;
    expect(hit.file.name.slice(start, end)).toBe("Report");
  });

  it("excludes trashed files", () => {
    const files = [file({ name: "gone.pdf", trashed: true })];
    expect(searchFiles(files, "gone")).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("withinOneEdit accepts substitutions, insertions, deletions", () => {
    expect(withinOneEdit("invoice", "invoise")).toBe(true);
    expect(withinOneEdit("invoice", "invoicee")).toBe(true);
    expect(withinOneEdit("invoice", "invoic")).toBe(true);
    expect(withinOneEdit("invoice", "involce")).toBe(true);
    expect(withinOneEdit("invoice", "inv")).toBe(false);
    expect(withinOneEdit("invoice", "recipes")).toBe(false);
  });

  it("highlightParts splits around ranges", () => {
    const parts = highlightParts("hello world", [{ start: 6, end: 11 }]);
    expect(parts).toEqual([
      { text: "hello ", hit: false },
      { text: "world", hit: true },
    ]);
  });
});
