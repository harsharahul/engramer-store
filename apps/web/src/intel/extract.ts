import type { ExifSignals } from "./categorize";

const TEXT_READ_LIMIT = 512 * 1024;
const TEXT_STORE_LIMIT = 100_000;
const PDF_PAGE_LIMIT = 40;

const TEXTUAL_EXTENSIONS =
  /\.(txt|md|markdown|org|json|yaml|yml|toml|csv|tsv|log|ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|rb|sh|css|html|xml|sql)$/i;

function isTextual(file: File): boolean {
  return file.type.startsWith("text/") || TEXTUAL_EXTENSIONS.test(file.name);
}

/**
 * Extracts searchable text on the client: plain text and code directly,
 * PDF through pdf.js (lazy-loaded so the viewer never pays for it upfront).
 */
export async function extractText(file: File): Promise<string | undefined> {
  try {
    if (isTextual(file) && file.size <= TEXT_READ_LIMIT) {
      const text = await file.text();
      return text.slice(0, TEXT_STORE_LIMIT) || undefined;
    }
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      return await extractPdfText(file);
    }
  } catch {
    // Extraction is best-effort; the file still uploads without search text.
  }
  return undefined;
}

async function extractPdfText(file: File): Promise<string | undefined> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await loadingTask.promise;
  const parts: string[] = [];
  const pages = Math.min(doc.numPages, PDF_PAGE_LIMIT);
  let total = 0;
  for (let i = 1; i <= pages && total < TEXT_STORE_LIMIT; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) {
      parts.push(pageText);
      total += pageText.length;
    }
  }
  await loadingTask.destroy();
  const text = parts.join("\n").slice(0, TEXT_STORE_LIMIT);
  return text || undefined;
}

/** EXIF capture time and camera make, extracted locally with exifr. */
export async function extractExif(file: File): Promise<ExifSignals | undefined> {
  if (!file.type.startsWith("image/")) {
    return undefined;
  }
  try {
    const exifr = await import("exifr");
    const data = (await exifr.parse(file, { pick: ["DateTimeOriginal", "Make"] })) as
      | { DateTimeOriginal?: Date; Make?: string }
      | undefined;
    if (!data) {
      return undefined;
    }
    const takenAt = data.DateTimeOriginal instanceof Date ? data.DateTimeOriginal.getTime() : undefined;
    const cameraMake = typeof data.Make === "string" ? data.Make : undefined;
    if (takenAt === undefined && cameraMake === undefined) {
      return undefined;
    }
    return { takenAt, cameraMake };
  } catch {
    return undefined;
  }
}
