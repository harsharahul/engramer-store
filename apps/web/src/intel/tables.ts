/**
 * Tables in text.
 *
 * The text of a PDF page or of an HTML mail keeps its rows: the cells of a
 * row stand on one line, parted by " | " (or, in text from other sources,
 * by tabs or by wide gaps). This module finds those rows again and groups
 * the ones that stand together, so that a reader can take a cell with the
 * header of its column: "07:30" under "Departs", "86.35" under
 * "Amount (GBP)".
 *
 * It knows nothing of what a label means. It only says where the cells
 * are, which line is a header, and which cell stands under which.
 */

import { findDates, findTimes } from "./dates";

/** One cell of a row. `at` and `end` are places in the whole text; an empty cell has no length. */
export interface Cell {
  at: number;
  end: number;
  text: string;
}

/**
 * Rows of cells that stand together, line under line. `rows[r][c]` stands
 * under `header[c]`; a cell a row does not have is empty.
 */
export interface TableBlock {
  at: number;
  end: number;
  header?: Cell[];
  rows: Cell[][];
}

/** How many data rows are looked at to tell a header from a first row of labels. */
const ROWS_SEEN = 5;
/** A sum of money, by its sign or by its two decimals. */
const AMOUNT = /[£$€¥]\s?\d|\b\d{1,3}(?:[,.\s]\d{3})*[.,]\d{2}\b/;
const NUMBER_ALONE = /^[-+(]?[\d.,\s]+\)?$/;

const isSpace = (code: number) => code === 32 || code === 9 || code === 13 || code === 160;

/** The cell between two places of a line, without the spaces around it. */
function cell(line: string, lineStart: number, from: number, to: number): Cell {
  let start = from;
  let stop = to;
  while (start < stop && isSpace(line.charCodeAt(start))) {
    start += 1;
  }
  while (stop > start && isSpace(line.charCodeAt(stop - 1))) {
    stop -= 1;
  }
  return { at: lineStart + start, end: lineStart + stop, text: line.slice(start, stop) };
}

/**
 * The cells of one line. A bar that stands between spaces (or at an edge of
 * the line) parts two cells, and an empty cell keeps its place. A line with
 * no such bar is parted at tabs, or else at gaps of three spaces or more.
 * Running words are one cell.
 */
export function cellsOf(line: string, lineStart: number): Cell[] {
  let first = 0;
  let last = line.length;
  while (first < last && isSpace(line.charCodeAt(first))) {
    first += 1;
  }
  while (last > first && isSpace(line.charCodeAt(last - 1))) {
    last -= 1;
  }
  if (first === last) {
    return [];
  }
  const cells: Cell[] = [];
  let from = first;
  for (let at = first; at < last; at++) {
    if (line.charCodeAt(at) === 124 && (at === first || line.charCodeAt(at - 1) === 32) && (at === last - 1 || line.charCodeAt(at + 1) === 32)) {
      cells.push(cell(line, lineStart, from, at));
      from = at + 1;
    }
  }
  if (cells.length === 0 && line.includes("\t")) {
    for (let at = first; at < last; at++) {
      if (line.charCodeAt(at) === 9) {
        cells.push(cell(line, lineStart, from, at));
        from = at + 1;
      }
    }
  }
  if (cells.length === 0) {
    for (let at = first; at < last; at++) {
      if (line.charCodeAt(at) !== 32) {
        continue;
      }
      let stop = at;
      while (stop < last && line.charCodeAt(stop) === 32) {
        stop += 1;
      }
      if (stop - at >= 3) {
        cells.push(cell(line, lineStart, from, at));
        from = stop;
      }
      at = stop - 1;
    }
  }
  cells.push(cell(line, lineStart, from, last));
  return cells;
}

/** Whether a cell holds a date, a clock or a sum of money: a value, where a header holds a name. */
function holdsValue(text: string): boolean {
  return /\d/.test(text) && (AMOUNT.test(text) || findTimes(text).length > 0 || findDates(text).length > 0);
}

interface Row {
  at: number;
  end: number;
  cells: Cell[];
  /** The row holds a digit: a value, where a row of names holds none. */
  valued: boolean;
}

/** The fewest cells a row of names needs to be the header of a new table under another one. */
const HEADER_CELLS = 3;

/** A row's cells, each under its column of a table `width` cells wide. */
function aligned(cells: Cell[], width: number, headed: boolean): Cell[] {
  if (cells.length >= width) {
    return cells;
  }
  const last = cells[cells.length - 1]!;
  const empty = (at: number): Cell => ({ at, end: at, text: "" });
  // A name and its sum ("Total paid | 160.00"): the sum stands in the last column.
  if (headed && cells.length === 2 && (AMOUNT.test(last.text) || NUMBER_ALONE.test(last.text))) {
    return [cells[0]!, ...Array.from({ length: width - 2 }, () => empty(last.at)), last];
  }
  return [...cells, ...Array.from({ length: width - cells.length }, () => empty(last.end))];
}

function blockOf(run: Row[]): TableBlock {
  const first = run[0]!.cells;
  const width = first.length;
  // A header holds names only. In a table of two columns it is a header only when the
  // first column under it holds values: else the block is labels and their values.
  let headed = !first.some((one) => holdsValue(one.text));
  if (headed && width === 2) {
    headed = run.slice(1, 1 + ROWS_SEEN).some((row) => holdsValue(row.cells[0]!.text));
  }
  return {
    at: run[0]!.at,
    end: run[run.length - 1]!.end,
    ...(headed ? { header: first } : {}),
    rows: (headed ? run.slice(1) : run).map((row) => aligned(row.cells, width, headed)),
  };
}

/**
 * The tables of a text: two or more lines, one under the other, each with
 * two or more cells that hold words. A row may have one cell more or fewer
 * than the first; rows of another width are a table of their own.
 */
export function tableBlocks(text: string): TableBlock[] {
  const blocks: TableBlock[] = [];
  let run: Row[] = [];
  const close = () => {
    if (run.length >= 2) {
      blocks.push(blockOf(run));
    }
    run = [];
  };
  let at = 0;
  for (;;) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(at, end);
    const cells = line.includes("|") || line.includes("\t") || line.includes("   ") ? cellsOf(line, at) : [];
    let worded = 0;
    for (const one of cells) {
      if (one.text !== "") {
        worded += 1;
      }
    }
    if (worded >= 2) {
      const valued = /\d/.test(line);
      const before = run[run.length - 1];
      // A table ends where the next one starts under it: at rows of another
      // width, and at a row of names that follows a row of values (the
      // header of the next table).
      if (before && (Math.abs(cells.length - run[0]!.cells.length) > 1 || (!valued && before.valued && cells.length >= HEADER_CELLS))) {
        close();
      }
      run.push({ at, end, cells, valued });
    } else {
      close();
    }
    if (newline === -1) {
      break;
    }
    at = newline + 1;
  }
  close();
  return blocks;
}

/** The header line of each table that has one. */
export function headerLines(text: string): { at: number; end: number }[] {
  return tableBlocks(text).flatMap((block) => {
    if (!block.header) {
      return [];
    }
    const newline = text.indexOf("\n", block.at);
    return [{ at: block.at, end: newline === -1 ? text.length : newline }];
  });
}
