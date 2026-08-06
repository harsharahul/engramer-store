import type { ExifSignals } from "./categorize";

const TEXT_READ_LIMIT = 512 * 1024;
const TEXT_STORE_LIMIT = 100_000;
const PDF_PAGE_LIMIT = 40;

const TEXTUAL_EXTENSIONS =
  /\.(txt|md|markdown|org|json|yaml|yml|toml|csv|tsv|log|ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|rb|sh|css|html|xml|sql)$/i;

function isTextual(file: File): boolean {
  return file.type.startsWith("text/") || TEXTUAL_EXTENSIONS.test(file.name);
}

export function isPdf(name: string, mime: string): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

const OFFICE_READ_LIMIT = 30 * 1024 * 1024;

function isDocx(name: string, mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(name)
  );
}

function isXlsx(name: string, mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.xlsx$/i.test(name)
  );
}

function isPptx(name: string, mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.pptx$/i.test(name)
  );
}

function isOffice(file: File): boolean {
  return (
    isDocx(file.name, file.type) || isXlsx(file.name, file.type) || isPptx(file.name, file.type)
  );
}

/**
 * Extracts searchable text on the client: plain text and code directly,
 * PDF through pdf.js, and Office documents at the data level: a .docx,
 * .xlsx or .pptx is a zip of XML, so the words come out of document.xml,
 * the shared-strings table and the slides without any renderer involved.
 * Everything lazy-loaded so the viewer never pays for it upfront.
 */
export async function extractText(file: File): Promise<string | undefined> {
  try {
    if (isTextual(file) && file.size <= TEXT_READ_LIMIT) {
      const text = await file.text();
      return text.slice(0, TEXT_STORE_LIMIT) || undefined;
    }
    if (isPdf(file.name, file.type)) {
      return await extractPdfText(file);
    }
    if (isOffice(file) && file.size <= OFFICE_READ_LIMIT) {
      return await extractOfficeText(file);
    }
  } catch {
    // Extraction is best-effort; the file still uploads without search text.
  }
  return undefined;
}

/** Tags stripped, paragraph boundaries kept, entities restored. */
function xmlToText(xml: string, paragraphEnd: RegExp): string {
  return xml
    .replace(paragraphEnd, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractOfficeText(file: File): Promise<string | undefined> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const wanted = (path: string) =>
    path === "word/document.xml" ||
    path === "xl/sharedStrings.xml" ||
    /^ppt\/slides\/slide\d+\.xml$/.test(path);
  // Only the entries that carry words are inflated; the images and themes
  // riding inside the same zip never get touched.
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => wanted(entry.name),
  });
  const parts: string[] = [];
  if (zip["word/document.xml"]) {
    parts.push(xmlToText(strFromU8(zip["word/document.xml"]!), /<\/w:p>/g));
  }
  if (zip["xl/sharedStrings.xml"]) {
    // One line per shared string: the cell texts, which is what someone
    // searching a spreadsheet is looking for.
    parts.push(xmlToText(strFromU8(zip["xl/sharedStrings.xml"]!), /<\/si>/g));
  }
  for (const path of Object.keys(zip)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort()) {
    parts.push(xmlToText(strFromU8(zip[path]!), /<\/a:p>/g));
  }
  const text = parts.join("\n").slice(0, TEXT_STORE_LIMIT).trim();
  return text || undefined;
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
