import { describe, expect, it } from "vitest";
import { categorize } from "./categorize";

const MTIME = Date.UTC(2026, 6, 19);

describe("categorize", () => {
  it("routes screenshots by name", () => {
    const result = categorize({
      name: "Screenshot 2026-07-19 at 09.41.00.png",
      mime: "image/png",
      mtime: MTIME,
    });
    expect(result.category).toBe("Screenshots");
    expect(result.tags).toContain("screenshot");
    expect(result.tags).toContain("png");
    expect(result.tags).toContain("2026");
  });

  it("routes camera photos with EXIF and tags the make and capture year", () => {
    const result = categorize({
      name: "IMG_4231.jpg",
      mime: "image/jpeg",
      mtime: MTIME,
      exif: { takenAt: Date.UTC(2024, 3, 2), cameraMake: "Apple iPhone" },
    });
    expect(result.category).toBe("Photos");
    expect(result.tags).toContain("apple");
    expect(result.tags).toContain("camera");
    expect(result.tags).toContain("2024");
    expect(result.tags).not.toContain("2026");
  });

  it("routes invoices to Receipts from extracted text", () => {
    const result = categorize({
      name: "march.pdf",
      mime: "application/pdf",
      mtime: MTIME,
      text: "INVOICE #2231\nBilled to: Harsha\nTotal due: $410.00",
    });
    expect(result.category).toBe("Receipts");
    expect(result.tags).toContain("invoice");
  });

  it("routes plain PDFs to Documents and tags contracts", () => {
    const doc = categorize({ name: "spec.pdf", mime: "application/pdf", mtime: MTIME });
    expect(doc.category).toBe("Documents");

    const contract = categorize({
      name: "lease.pdf",
      mime: "application/pdf",
      mtime: MTIME,
      text: "This Agreement is made between the parties, hereinafter the Tenant...",
    });
    expect(contract.category).toBe("Documents");
    expect(contract.tags).toContain("contract");
  });

  it("routes code, notes, spreadsheets, archives, and books by extension", () => {
    expect(categorize({ name: "main.rs", mime: "", mtime: MTIME }).category).toBe("Code");
    expect(categorize({ name: "ideas.md", mime: "text/markdown", mtime: MTIME }).category).toBe("Notes");
    expect(categorize({ name: "budget.csv", mime: "text/csv", mtime: MTIME }).category).toBe("Spreadsheets");
    expect(categorize({ name: "backup.tar.gz", mime: "application/gzip", mtime: MTIME }).category).toBe("Archives");
    expect(categorize({ name: "novel.epub", mime: "application/epub+zip", mtime: MTIME }).category).toBe("Books");
    expect(categorize({ name: "deck.pptx", mime: "", mtime: MTIME }).category).toBe("Presentations");
    expect(categorize({ name: "logo.svg", mime: "image/svg+xml", mtime: MTIME }).category).toBe("Design");
  });

  it("falls back to Other and always tags category and year", () => {
    const result = categorize({ name: "mystery.bin", mime: "", mtime: MTIME });
    expect(result.category).toBe("Other");
    expect(result.tags).toContain("other");
    expect(result.tags).toContain("bin");
    expect(result.tags).toContain("2026");
  });
});
