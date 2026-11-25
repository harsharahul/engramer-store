/**
 * A PDF page as its lines and columns.
 *
 * A PDF holds no lines: it places pieces of text at points on a page. Read
 * in the order they are stored and joined with spaces, a page is one long
 * line, and a table is a run of words. A person sees more: pieces on one
 * baseline are a line, a wide gap in a line parts two columns, and a tall
 * gap parts two blocks. This module puts that back, from the place and size
 * of each piece alone:
 *
 * - pieces on one baseline, left to right, are one line;
 * - a gap wider than two characters is a cell boundary, written " | ";
 * - a tall gap between two lines is a blank line;
 * - a sentence the page wrapped is one line again;
 * - text set sideways comes last, each piece on a line of its own.
 *
 * Every reader that works on lines (form fields, tables, a clock under its
 * date) depends on this.
 */

/** One piece of text as the page places it: its left end, its baseline, and its size. */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Set sideways or at an angle. */
  rotated?: true;
}

/** The pieces of a page, from what pdf.js reports for it. Marks that carry no text are left out. */
export function pdfItemsOf(content: { items: readonly unknown[] }): PdfItem[] {
  const items: PdfItem[] = [];
  for (const raw of content.items) {
    const item = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
    if (typeof item.str !== "string" || !Array.isArray(item.transform) || item.transform.length < 6) {
      continue;
    }
    const [a = 0, b = 0, c = 0, d = 0, x = Number.NaN, y = Number.NaN] = item.transform as number[];
    const height = Number(item.height) || Math.hypot(c, d) || Math.hypot(a, b);
    // Only the direction of the baseline says that text is set at an angle: slanted text is upright.
    const rotated = a <= 0 || Math.abs(b) > 0.1 * Math.abs(a);
    // A piece that states no width is taken to be as wide as its characters.
    const width = Number(item.width) || item.str.length * height * 0.5;
    items.push({ str: item.str, x, y, width, height, ...(rotated ? { rotated: true as const } : {}) });
  }
  return items;
}

/** A gap wider than this many characters parts two cells. */
const CELL_GAP = 2;
/** A gap wider than this part of a character is a space. */
const SPACE_GAP = 0.25;
/** Two baselines further apart than this many line heights are two blocks. */
const BLOCK_GAP = 1.8;
/** A word at a line's end that the next line must go on from. In small letters only: "Grade: A" and "State: OR" end with a value. */
const GOES_ON = /\b(?:a|an|the|of|on|at|by|to|in|for|and|or|with|from|your|our|until|before|after)$/;

interface Line {
  y: number;
  height: number;
  left: number;
  cells: number;
  text: string;
}

/** The width of one character between two pieces, from the pieces' own widths. */
function characterWidth(a: PdfItem, b: PdfItem): number {
  const letters = a.str.length + b.str.length;
  const width = a.width + b.width;
  return letters > 0 && width > 0 ? width / letters : Math.max(a.height, b.height) * 0.5;
}

/** One line from the pieces on its baseline. */
function lineOf(parts: PdfItem[]): Line {
  parts.sort((a, b) => a.x - b.x);
  const pieces: string[] = [];
  let cells = 1;
  let height = 0;
  let last: PdfItem | undefined;
  /** How far right the line has come. */
  let reach = 0;
  for (const part of parts) {
    if (last) {
      const gap = part.x - reach;
      const unit = characterWidth(last, part);
      if (gap > CELL_GAP * unit) {
        pieces.push(" | ");
        cells += 1;
      } else if (gap > SPACE_GAP * unit || gap < -unit) {
        // A small gap is a space. So is a piece that lies over the one before it: two runs, never one word.
        pieces.push(" ");
      }
    }
    pieces.push(part.str);
    height = Math.max(height, part.height);
    reach = last ? Math.max(reach, part.x + part.width) : part.x + part.width;
    last = part;
  }
  return { y: parts[0]!.y, height, left: parts[0]!.x, cells, text: pieces.join("").replace(/\s+/g, " ").trim() };
}

/**
 * Whether a piece stands on a row's baseline: within half a line of it. Of
 * two very different sizes the smaller one says how far that is, so a stamp
 * or a tall heading has no say over the lines beside it; a small raised
 * sign still belongs to the amount it stands before.
 */
function onBaseline(row: { y: number; height: number }, y: number, height: number): boolean {
  const small = Math.min(row.height, height);
  const large = Math.max(row.height, height);
  return Math.abs(row.y - y) <= 0.5 * (large <= 2 * small ? large : small);
}

/** Whether the page wrapped a sentence between these two lines. */
function wrapped(line: Line, next: Line): boolean {
  if (line.cells > 1 || next.cells > 1) {
    return false;
  }
  const size = Math.max(line.height, next.height);
  if (Math.abs(line.height - next.height) > 0.1 * size || Math.abs(line.left - next.left) > size) {
    return false;
  }
  return /^\p{Ll}/u.test(next.text) || GOES_ON.test(line.text);
}

/** The text of a page: its lines, the cells of a row parted by " | ", its blocks parted by a blank line. */
export function pdfLines(items: readonly PdfItem[]): string {
  const placed = items.filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && item.str.trim() !== "");
  const upright = placed.filter((item) => !item.rotated).sort((a, b) => b.y - a.y || a.x - b.x);

  // Pieces on one baseline are one line. A piece half a line off is the next line.
  const rows: PdfItem[][] = [];
  let top: { y: number; height: number } | undefined;
  for (const item of upright) {
    const height = item.height || 10;
    if (top && onBaseline(top, item.y, height)) {
      rows[rows.length - 1]!.push(item);
    } else {
      rows.push([item]);
      top = { y: item.y, height };
    }
  }

  const out: string[] = [];
  let before: Line | undefined;
  for (const line of rows.map(lineOf)) {
    if (!line.text) {
      continue;
    }
    if (before) {
      const apart = before.y - line.y > BLOCK_GAP * Math.max(before.height, line.height);
      if (!apart && wrapped(before, line)) {
        out[out.length - 1] = `${out[out.length - 1]} ${line.text}`;
        before = { ...line, text: out[out.length - 1]! };
        continue;
      }
      if (apart) {
        out.push("");
      }
    }
    out.push(line.text);
    before = line;
  }

  const sideways = placed.filter((item) => item.rotated).map((item) => item.str.trim());
  if (sideways.length > 0) {
    if (out.length > 0) {
      out.push("");
    }
    out.push(...sideways);
  }
  return out.join("\n");
}
