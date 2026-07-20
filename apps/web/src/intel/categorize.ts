/**
 * Client-side auto-categorization. Pure functions over signals that are all
 * available on the device: names, types, EXIF, dimensions, and extracted text.
 * The result is stored inside the encrypted metadata; the server never sees it.
 */

export type Category =
  | "Photos"
  | "Screenshots"
  | "Videos"
  | "Audio"
  | "Documents"
  | "Receipts"
  | "Notes"
  | "Code"
  | "Spreadsheets"
  | "Presentations"
  | "Design"
  | "Archives"
  | "Books"
  | "Other";

export interface AnalysisInput {
  name: string;
  mime: string;
  /** Modification time, ms epoch. */
  mtime: number;
  text?: string;
  exif?: ExifSignals;
}

export interface ExifSignals {
  /** Capture time, ms epoch. */
  takenAt?: number;
  cameraMake?: string;
}

export interface Analysis {
  category: Category;
  tags: string[];
}

const SCREENSHOT_NAME = /screen\s?shot|screencap|cleanshot|capture d.écran|^scr[-_]|bildschirmfoto/i;
const SCREEN_RECORDING_NAME = /screen\s?recording|screenrec/i;
const CAMERA_NAME = /^(img|dsc|dscf|dcim|pxl|gopr|djim?|p\d{7})[-_]?\d/i;

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cc", "rb", "php", "sh", "zsh", "bash", "sql", "css",
  "scss", "html", "vue", "svelte", "lua", "r", "pl", "ex", "exs", "zig", "toml",
  "yaml", "yml", "json", "xml", "dockerfile", "tf", "proto",
]);
const SPREADSHEET_EXT = new Set(["xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv"]);
const PRESENTATION_EXT = new Set(["ppt", "pptx", "key", "odp"]);
const DESIGN_EXT = new Set(["svg", "psd", "ai", "sketch", "fig", "xd", "eps", "ttf", "otf", "woff", "woff2", "blend"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso"]);
const BOOK_EXT = new Set(["epub", "mobi", "azw", "azw3"]);
const NOTE_EXT = new Set(["md", "markdown", "txt", "rtf", "org"]);
const DOCUMENT_EXT = new Set(["pdf", "doc", "docx", "odt", "pages"]);

const RECEIPT_TEXT = /\b(invoice|receipt|amount\s+(due|paid)|total\s+due|subtotal|order\s+(no|number|#|confirmation)|billed\s+to|payment\s+received)\b/i;
const INVOICE_TEXT = /\binvoice\b/i;
const CONTRACT_TEXT = /\b(agreement|contract|hereinafter|whereas|terms\s+and\s+conditions|governing\s+law)\b/i;
const RESUME_TEXT = /\b(curriculum\s+vitae|résumé|work\s+experience|professional\s+summary)\b/i;
const TAX_TEXT = /\b(form\s+1040|tax\s+return|w-2|1099|taxable\s+income)\b/i;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function categorize(input: AnalysisInput): Analysis {
  const ext = extensionOf(input.name);
  const tags = new Set<string>();
  const category = pickCategory(input, ext, tags);

  tags.add(category.toLowerCase());
  if (ext) {
    tags.add(ext);
  }
  const when = input.exif?.takenAt ?? input.mtime;
  if (Number.isFinite(when) && when > 0) {
    tags.add(String(new Date(when).getFullYear()));
  }
  if (input.exif?.cameraMake) {
    tags.add(input.exif.cameraMake.trim().toLowerCase().split(/\s+/)[0]!);
  }

  return { category, tags: [...tags] };
}

function pickCategory(input: AnalysisInput, ext: string, tags: Set<string>): Category {
  const { name, mime, text } = input;

  if (mime.startsWith("image/")) {
    if (SCREENSHOT_NAME.test(name)) {
      tags.add("screenshot");
      return "Screenshots";
    }
    if (DESIGN_EXT.has(ext)) {
      return "Design";
    }
    if (input.exif?.cameraMake || CAMERA_NAME.test(name)) {
      tags.add("camera");
      return "Photos";
    }
    return "Photos";
  }
  if (mime.startsWith("video/")) {
    if (SCREEN_RECORDING_NAME.test(name)) {
      tags.add("screen-recording");
    }
    return "Videos";
  }
  if (mime.startsWith("audio/")) {
    return "Audio";
  }
  if (DOCUMENT_EXT.has(ext) || mime === "application/pdf") {
    return categorizeDocument(text, tags);
  }
  if (SPREADSHEET_EXT.has(ext)) {
    return "Spreadsheets";
  }
  if (PRESENTATION_EXT.has(ext)) {
    return "Presentations";
  }
  if (DESIGN_EXT.has(ext)) {
    return "Design";
  }
  if (ARCHIVE_EXT.has(ext)) {
    return "Archives";
  }
  if (BOOK_EXT.has(ext)) {
    return "Books";
  }
  if (CODE_EXT.has(ext) || name.toLowerCase() === "dockerfile" || name.toLowerCase() === "makefile") {
    return "Code";
  }
  if (NOTE_EXT.has(ext) || mime.startsWith("text/")) {
    if (text && documentTags(text, tags)) {
      return "Receipts";
    }
    return "Notes";
  }
  return "Other";
}

function categorizeDocument(text: string | undefined, tags: Set<string>): Category {
  if (text) {
    if (documentTags(text, tags)) {
      return "Receipts";
    }
    if (CONTRACT_TEXT.test(text)) {
      tags.add("contract");
      return "Documents";
    }
    if (RESUME_TEXT.test(text)) {
      tags.add("resume");
      return "Documents";
    }
    if (TAX_TEXT.test(text)) {
      tags.add("tax");
      return "Documents";
    }
  }
  return "Documents";
}

/** Adds receipt-family tags; returns true when the text reads like a receipt or invoice. */
function documentTags(text: string, tags: Set<string>): boolean {
  const sample = text.slice(0, 20_000);
  if (!RECEIPT_TEXT.test(sample)) {
    return false;
  }
  tags.add(INVOICE_TEXT.test(sample) ? "invoice" : "receipt");
  return true;
}
