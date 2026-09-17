import { PDFDocument, degrees } from "pdf-lib";

/**
 * Page operations on a PDF, as pure functions from bytes to bytes.
 *
 * The viewer's Pages mode offers rotate, reorder, delete, extract, merge
 * and split; each is one call here and one write through the same save
 * path every editor uses, so versions, sync and the byte-count check
 * come for free. Page numbers are 1-based, as the viewer shows them.
 */

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  // ignoreEncryption: a document with an empty owner password still opens
  // and the operations apply; a truly locked one fails loudly downstream.
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

function indices(pages: readonly number[], total: number): number[] {
  const unique = [...new Set(pages)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
  return unique.map((n) => n - 1);
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}

/** Turns the given pages by `by` degrees (a multiple of 90), the rest untouched. */
export async function rotatePages(bytes: Uint8Array, pages: readonly number[], by: 90 | 180 | 270 | -90): Promise<Uint8Array> {
  const doc = await load(bytes);
  for (const index of indices(pages, doc.getPageCount())) {
    const page = doc.getPage(index);
    const current = page.getRotation().angle;
    page.setRotation(degrees((((current + by) % 360) + 360) % 360));
  }
  return doc.save();
}

/** Rebuilds the document in the given order; every page must appear once. */
export async function reorderPages(bytes: Uint8Array, order: readonly number[]): Promise<Uint8Array> {
  const source = await load(bytes);
  const total = source.getPageCount();
  const wanted = indices(order, total);
  if (wanted.length !== total) {
    throw new Error("the new order must name every page exactly once");
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, wanted);
  for (const page of copied) {
    out.addPage(page);
  }
  return out.save();
}

export async function deletePages(bytes: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  const doc = await load(bytes);
  const gone = new Set(indices(pages, doc.getPageCount()));
  if (gone.size >= doc.getPageCount()) {
    throw new Error("a document keeps at least one page");
  }
  // Remove from the back so earlier indices stay valid.
  for (const index of [...gone].sort((a, b) => b - a)) {
    doc.removePage(index);
  }
  return doc.save();
}

/** The given pages as a new document, in document order. */
export async function extractPages(bytes: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  const source = await load(bytes);
  const wanted = indices(pages, source.getPageCount()).sort((a, b) => a - b);
  if (wanted.length === 0) {
    throw new Error("choose at least one page");
  }
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(source, wanted)) {
    out.addPage(page);
  }
  return out.save();
}

/** One document from many, in the order given. */
export async function mergeDocuments(documents: readonly Uint8Array[]): Promise<Uint8Array> {
  if (documents.length === 0) {
    throw new Error("nothing to combine");
  }
  const out = await PDFDocument.create();
  for (const bytes of documents) {
    const source = await load(bytes);
    const all = source.getPageIndices();
    for (const page of await out.copyPages(source, all)) {
      out.addPage(page);
    }
  }
  return out.save();
}

/** What the Pages mode accumulates before one save: the surviving pages
 * in their new order (1-based source numbers) and a turn per page. */
export interface PagePlan {
  order: readonly number[];
  rotations: Readonly<Record<number, number>>;
}

/** Applies a whole plan in one pass, so a reorder, a few turns and a
 * deletion cost one version, not one each. */
export async function applyPagePlan(bytes: Uint8Array, plan: PagePlan): Promise<Uint8Array> {
  const source = await load(bytes);
  const wanted = indices(plan.order, source.getPageCount());
  if (wanted.length === 0) {
    throw new Error("a document keeps at least one page");
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, wanted);
  copied.forEach((page, position) => {
    const sourceNumber = wanted[position]! + 1;
    const turn = plan.rotations[sourceNumber] ?? 0;
    if (turn) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((((current + turn) % 360) + 360) % 360));
    }
    out.addPage(page);
  });
  return out.save();
}

/** One document per page. */
export async function splitDocument(bytes: Uint8Array): Promise<Uint8Array[]> {
  const source = await load(bytes);
  const parts: Uint8Array[] = [];
  for (const index of source.getPageIndices()) {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(source, [index]);
    out.addPage(page!);
    parts.push(await out.save());
  }
  return parts;
}
