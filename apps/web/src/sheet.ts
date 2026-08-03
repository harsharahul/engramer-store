/**
 * Reads enough of a .xlsx to show it.
 *
 * A spreadsheet is a zip of XML, and a preview needs only the parts that say
 * what the cells contain: the sheet names, the shared string table, and the
 * cells themselves. Everything else a workbook carries, formulas, charts,
 * pivot caches, formatting, belongs to the editor rather than to a glance at
 * the contents, so none of it is parsed here.
 *
 * Deliberately bounded. A preview opens on a file whose size the user has
 * not thought about, so it reads a window of rows and columns rather than
 * whatever the sheet declares, and says when it has stopped short.
 */
import JSZip from "jszip";

export interface SheetPreview {
  name: string;
  /** Row-major cells, already trimmed to the window below. */
  rows: string[][];
  /** True when the sheet continues past what was read. */
  truncated: boolean;
}

export interface WorkbookPreview {
  sheets: SheetPreview[];
}

export const MAX_ROWS = 200;
export const MAX_COLUMNS = 40;
/** Sheets past this are named but not read; a preview is not a workbook. */
const MAX_SHEETS = 12;

/** "BC7" -> 54. Spreadsheet columns are base-26 with no zero. */
export function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference) {
    const value = character.toUpperCase().charCodeAt(0) - 64;
    if (value < 1 || value > 26) {
      break;
    }
    index = index * 26 + value;
  }
  return index - 1;
}

function text(node: Element | null): string {
  return node?.textContent ?? "";
}

/**
 * The shared string table, where most cell text actually lives. Runs inside a
 * string are concatenated, which is how a cell with mixed formatting reads
 * back as one value.
 */
function sharedStrings(xml: Document): string[] {
  return [...xml.getElementsByTagName("si")].map((si) => {
    const runs = si.getElementsByTagName("t");
    return [...runs].map((t) => t.textContent ?? "").join("");
  });
}

function parse(content: string): Document {
  return new DOMParser().parseFromString(content, "application/xml");
}

function cellValue(cell: Element, strings: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return [...cell.getElementsByTagName("t")].map((t) => t.textContent ?? "").join("");
  }
  const raw = text(cell.getElementsByTagName("v")[0] ?? null);
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) ? (strings[index] ?? "") : "";
  }
  // Everything else is already its own text: numbers, booleans, dates as
  // serial numbers, and the cached result of a formula.
  return raw;
}

function readSheet(xml: Document, strings: string[], name: string): SheetPreview {
  const rows: string[][] = [];
  let truncated = false;
  const sheetRows = xml.getElementsByTagName("row");
  for (const row of [...sheetRows]) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    for (const cell of [...row.getElementsByTagName("c")]) {
      // A row lists only the cells that exist, so a gap has to be placed by
      // its reference rather than by counting.
      const reference = cell.getAttribute("r") ?? "";
      const at = columnIndex(reference.replace(/\d+/g, ""));
      if (at < 0 || at >= MAX_COLUMNS) {
        if (at >= MAX_COLUMNS) {
          truncated = true;
        }
        continue;
      }
      while (cells.length < at) {
        cells.push("");
      }
      cells[at] = cellValue(cell, strings);
    }
    rows.push(cells);
  }
  // Trailing empty rows and columns say nothing; drop them so a sheet with a
  // used range of three cells does not preview as a wall of blanks.
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((cell) => cell === "")) {
    rows.pop();
  }
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return { name, rows: rows.map((row) => [...row, ...Array(width - row.length).fill("")]), truncated };
}

/**
 * Reads a workbook far enough to display it. Throws if the bytes are not a
 * workbook at all, which the caller shows as a file it cannot preview.
 */
export async function readWorkbook(bytes: Uint8Array): Promise<WorkbookPreview> {
  const zip = await JSZip.loadAsync(bytes.slice().buffer as ArrayBuffer);
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) {
    throw new Error("not a workbook");
  }
  const workbook = parse(await workbookFile.async("string"));

  // Sheet order and names come from the workbook; the file each one lives in
  // comes from the relationships beside it.
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const relationships = new Map<string, string>();
  if (relsFile) {
    const rels = parse(await relsFile.async("string"));
    for (const rel of [...rels.getElementsByTagName("Relationship")]) {
      relationships.set(rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? "");
    }
  }

  const stringsFile = zip.file("xl/sharedStrings.xml");
  const strings = stringsFile ? sharedStrings(parse(await stringsFile.async("string"))) : [];

  const sheets: SheetPreview[] = [];
  const declared = [...workbook.getElementsByTagName("sheet")].slice(0, MAX_SHEETS);
  for (const [position, sheet] of declared.entries()) {
    const name = sheet.getAttribute("name") ?? `Sheet ${position + 1}`;
    const id = sheet.getAttribute("r:id") ?? sheet.getAttributeNS("*", "id") ?? "";
    const target = relationships.get(id) ?? `worksheets/sheet${position + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const file = zip.file(path) ?? zip.file(`xl/worksheets/sheet${position + 1}.xml`);
    if (!file) {
      sheets.push({ name, rows: [], truncated: false });
      continue;
    }
    sheets.push(readSheet(parse(await file.async("string")), strings, name));
  }
  if (sheets.length === 0) {
    throw new Error("no sheets");
  }
  return { sheets };
}
