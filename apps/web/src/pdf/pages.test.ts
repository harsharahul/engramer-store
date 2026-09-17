import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyPagePlan,
  deletePages,
  extractPages,
  mergeDocuments,
  pageCount,
  reorderPages,
  rotatePages,
  splitDocument,
} from "./pages";

/**
 * Page operations are pure functions from bytes to bytes, so the viewer's
 * Pages mode can offer rotate, reorder, delete, extract, merge and split
 * without knowing how a PDF is put together, and a save is one write
 * through the same path every editor uses.
 */

let three: Uint8Array;

/** Each label maps to a distinct page width, so order is checkable
 * from the geometry pdf-lib exposes without extracting text. */
const WIDTHS: Record<string, number> = {
  "page-a": 300,
  "page-b": 310,
  "page-c": 320,
  "page-d": 330,
  "page-e": 340,
};

async function labelled(labels: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of labels) {
    const page = doc.addPage([WIDTHS[label]!, 400]);
    page.drawText(label, { x: 20, y: 360, size: 24, font });
  }
  return doc.save();
}

async function labelsOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const byWidth = new Map(Object.entries(WIDTHS).map(([label, width]) => [width, label]));
  return doc.getPages().map((page) => byWidth.get(Math.round(page.getWidth())) ?? "?");
}

beforeAll(async () => {
  three = await labelled(["page-a", "page-b", "page-c"]);
});

describe("pdf page operations", () => {
  it("counts pages", async () => {
    expect(await pageCount(three)).toBe(3);
  });

  it("rotates only the pages asked for", async () => {
    const out = await rotatePages(three, [2], 90);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
  });

  it("reorders pages", async () => {
    const out = await reorderPages(three, [3, 1, 2]);
    expect(await labelsOf(out)).toEqual(["page-c", "page-a", "page-b"]);
  });

  it("deletes pages and refuses to delete them all", async () => {
    const out = await deletePages(three, [2]);
    expect(await labelsOf(out)).toEqual(["page-a", "page-c"]);
    await expect(deletePages(three, [1, 2, 3])).rejects.toThrow(/at least one page/);
  });

  it("extracts pages into a new document", async () => {
    const out = await extractPages(three, [1, 3]);
    expect(await labelsOf(out)).toEqual(["page-a", "page-c"]);
    expect(await pageCount(three)).toBe(3);
  });

  it("merges documents in the order given", async () => {
    const two = await labelled(["page-d", "page-e"]);
    const out = await mergeDocuments([two, three]);
    expect(await labelsOf(out)).toEqual(["page-d", "page-e", "page-a", "page-b", "page-c"]);
  });

  it("applies a whole plan at once: the surviving pages in their new order, each with its turn", async () => {
    const out = await applyPagePlan(three, { order: [3, 1], rotations: { 3: 90 } });
    expect(await labelsOf(out)).toEqual(["page-c", "page-a"]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0]);
  });

  it("splits a document into one file per page", async () => {
    const parts = await splitDocument(three);
    expect(parts).toHaveLength(3);
    expect(await labelsOf(parts[1]!)).toEqual(["page-b"]);
  });
});
