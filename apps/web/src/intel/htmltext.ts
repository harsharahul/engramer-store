/**
 * Markup read as text, and the one rule for which body of a message is
 * read. No DOM is used, so this runs wherever text is extracted.
 *
 * An HTML mail is laid out with tables. Read as text it keeps what a person
 * sees: a block is a line, a row of cells is one line with " | " between
 * its cells, a list item starts with a dash, a quoted message is marked
 * line by line with "> ", and what the page hides from the eye is left out.
 * Every reader that works on lines (form fields, tables, quoted mail)
 * depends on this.
 *
 * The walk is one pass over the tags. It keeps counters, never a tree, so
 * its time is in proportion to the input whatever the input holds.
 */

/** Elements whose content is never text of the page; each ends at its own closing tag. */
const RAW = new Set(["style", "script", "noscript", "template", "title", "svg", "select", "textarea", "xml", "iframe", "object", "datalist"]);
/** Elements with no content of their own. */
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
/** Elements that stand on lines of their own. */
const BLOCK = new Set([
  "div", "dt", "dd", "section", "article", "header", "footer", "main", "aside", "nav", "address", "figure", "figcaption", "form", "fieldset", "center", "pre", "tbody", "thead",
  "tfoot", "caption", "tr", "td", "th",
]);
/** Blocks that a blank line parts from what stands around them. */
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "hr"]);
/** Tables nested deeper than any mail are read as plain blocks. */
const MAX_TABLE_DEPTH = 50;
/** The most columns one cell is taken to span. */
const MAX_SPAN = 12;
/** The most "> " marks one line carries. */
const MAX_QUOTE_MARKS = 8;
/** The most lines a cell of a row may hold: a value and a note. */
const MAX_CELL_LINES = 2;

/** A style that takes its element, and all it holds, out of sight. */
const HIDING =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|max-height\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?)\s*(?:!\s*important\s*)?(?=;|$)/i;
/** A text size stated on an element; a size of nothing hides the text until an element inside states a size again. */
const FONT_SIZE = /(?:^|;)\s*font-size\s*:\s*([^;!]+)/i;
const NOTHING = /^0(?:\.0+)?(?:px|pt|em|rem|%)?$/i;
/** Characters with no width, used to pad a preview line. */
const NO_WIDTH = new RegExp(`[${String.fromCodePoint(0xad, 0x34f, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)}]`, "g");

/** Punctuation is given by its number, so that this file holds no character that looks like another. */
const ENTITIES = new Map<string, string>([
  ...Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
    pound: "£", euro: "€", yen: "¥", cent: "¢", curren: "¤", dollar: "$",
    copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
    middot: "·", laquo: "«", raquo: "»", sect: "§", para: "¶", zwnj: "", zwj: "", shy: "",
  }),
  ...Object.entries({
    minus: 0x2212, ndash: 0x2013, mdash: 0x2014, hellip: 0x2026, bull: 0x2022,
    lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d, sbquo: 0x201a, bdquo: 0x201e, prime: 0x2032, Prime: 0x2033,
    rarr: 0x2192, larr: 0x2190, check: 0x2713,
  }).map(([name, code]): [string, string] => [name, String.fromCodePoint(code)]),
]);
/** The entities a browser reads with no semicolon. */
const NO_SEMICOLON = ["amp", "lt", "gt", "quot", "nbsp", "pound", "yen", "cent", "copy", "reg"];
/** What the numbers 128 to 159 mean in mail written on older systems. */
const WINDOWS_1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/** Named and numbered entities restored, as a browser reads them; one that is not known stays as written. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10})(;?)/g, (whole, name: string, semicolon: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code >= 128 && code <= 159) {
        return String.fromCodePoint(WINDOWS_1252[code - 128]!);
      }
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    if (semicolon) {
      return ENTITIES.get(name) ?? whole;
    }
    const known = NO_SEMICOLON.find((entity) => name.startsWith(entity));
    return known ? `${ENTITIES.get(known)}${name.slice(known.length)}` : whole;
  });
}

interface Tag {
  /** Where the text after the tag starts. */
  end: number;
  closing: boolean;
  name: string;
  style: string;
  hidden: boolean;
  /** Columns a cell takes. */
  span: number;
}

const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);
const isLetter = (code: number) => (code | 32) >= 97 && (code | 32) <= 122;
const isNameCharacter = (code: number) => isLetter(code) || (code >= 48 && code <= 58) || code === 45 || code === 46 || code === 95;

/**
 * One tag, read as a browser reads it: a quote mark is a quote only after
 * an equals sign. Null when the source ends inside the tag. `quotes` notes
 * a kind of quote mark that does not come again, so no search is made twice.
 */
function readTag(html: string, lt: number, quotes: { '"': boolean; "'": boolean }): Tag | null {
  const length = html.length;
  let at = lt + 1;
  const closing = html.charCodeAt(at) === 47;
  if (closing) {
    at += 1;
  }
  const nameStart = at;
  while (at < length && isNameCharacter(html.charCodeAt(at))) {
    at += 1;
  }
  const tag: Tag = { end: length, closing, name: html.slice(nameStart, at).toLowerCase(), style: "", hidden: false, span: 1 };
  for (;;) {
    while (at < length && (isSpace(html.charCodeAt(at)) || html.charCodeAt(at) === 47)) {
      at += 1;
    }
    if (at >= length) {
      return null;
    }
    if (html.charCodeAt(at) === 62) {
      tag.end = at + 1;
      return tag;
    }
    const attributeStart = at;
    at += 1;
    while (at < length) {
      const code = html.charCodeAt(at);
      if (isSpace(code) || code === 61 || code === 62 || code === 47) {
        break;
      }
      at += 1;
    }
    const attribute = html.slice(attributeStart, at).toLowerCase();
    while (at < length && isSpace(html.charCodeAt(at))) {
      at += 1;
    }
    let value = "";
    if (html.charCodeAt(at) === 61) {
      at += 1;
      while (at < length && isSpace(html.charCodeAt(at))) {
        at += 1;
      }
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const close = quotes[quote] ? html.indexOf(quote, at + 1) : -1;
        if (close === -1) {
          // A quote never closed: the tag ends where a tag ends.
          quotes[quote] = false;
          const gt = html.indexOf(">", at);
          if (gt === -1) {
            return null;
          }
          tag.end = gt + 1;
          return tag;
        }
        value = html.slice(at + 1, close);
        at = close + 1;
      } else {
        const valueStart = at;
        while (at < length && !isSpace(html.charCodeAt(at)) && html.charCodeAt(at) !== 62) {
          at += 1;
        }
        value = html.slice(valueStart, at);
      }
    }
    if (attribute === "style") {
      tag.style = value;
    } else if (attribute === "hidden") {
      tag.hidden = true;
    } else if (attribute === "colspan") {
      tag.span = Math.min(MAX_SPAN, Math.max(1, Number.parseInt(value, 10) || 1));
    }
  }
}

const RAW_END = new Map<string, RegExp>();

/** Where the text goes on after an element whose content is not text. */
function afterRaw(html: string, name: string, from: number): number {
  let close = RAW_END.get(name);
  if (!close) {
    close = new RegExp(`</${name}(?=[\\s>/])`, "gi");
    RAW_END.set(name, close);
  }
  close.lastIndex = from;
  const found = close.exec(html);
  const gt = found ? html.indexOf(">", found.index) : -1;
  return gt === -1 ? html.length : gt + 1;
}

interface Line {
  text: string;
  /** How many quoted messages deep the line stands. */
  quote: number;
  blank?: true;
  /** The line follows the one above after a line break, with no block between them. */
  soft?: true;
}

/** What is being written: the page itself, or one cell of a row. */
interface Frame {
  lines: Line[];
  /** The words of the line still open. */
  open: string;
  /** A blank line is owed before the next line. */
  gap: boolean;
  /** The next line follows a line break only. */
  soft: boolean;
  /** A block began before the first line. */
  lead: boolean;
  /** The next line is a list item. */
  bullet: boolean;
  /** Columns the cell takes. */
  span: number;
}

interface Row {
  /** The table the row belongs to, by depth. */
  depth: number;
  cells: Frame[];
  cellOpen: boolean;
}

/** A piece of the page that is out of sight, with all it holds. */
interface Gone {
  name: string;
  /** Elements of that name open inside it, itself counted. */
  depth: number;
  /** A row and a cell open inside it, at the table depth it has reached. */
  row: boolean;
  cell: boolean;
  /** The same for each table open inside it. */
  outer: [row: boolean, cell: boolean][];
}

/** An element that states a text size: nothing, or a size again inside one of nothing. */
interface Sized {
  name: string;
  depth: number;
  nothing: boolean;
  /** How many frames were open when it began: it ends with its cell at the latest. */
  frame: number;
}

const newFrame = (span = 1): Frame => ({ lines: [], open: "", gap: false, soft: false, lead: false, bullet: false, span });
const isCell = (name: string) => name === "td" || name === "th";

/** HTML as its lines, and how many of them are rows of cells. */
function layOut(html: string): { text: string; rows: number } {
  const frames: Frame[] = [newFrame()];
  const rows: Row[] = [];
  const sized: Sized[] = [];
  const quotes = { '"': true, "'": true };
  let gone: Gone | null = null;
  let quote = 0;
  let tables = 0;
  let rowLines = 0;
  const top = () => frames[frames.length - 1]!;
  const muted = () => sized.length > 0 && sized[sized.length - 1]!.nothing;

  const push = (frame: Frame, text: string, depth: number) => {
    const first = frame.lines.length === 0;
    if (frame.gap) {
      if (first) {
        frame.lead = true;
      } else {
        frame.lines.push({ text: "", quote: depth, blank: true });
      }
    }
    frame.lines.push(frame.soft && !frame.gap && !first ? { text, quote: depth, soft: true } : { text, quote: depth });
    frame.gap = false;
    frame.soft = false;
  };
  /** Ends the open line; true when it held words. */
  const flush = (): boolean => {
    const frame = top();
    if (!frame.open) {
      return false;
    }
    const text = frame.open.replace(NO_WIDTH, "").replace(/\s+/g, " ").trim();
    frame.open = "";
    if (!text) {
      return false;
    }
    push(frame, frame.bullet ? `- ${text}` : text, quote);
    frame.bullet = false;
    return true;
  };
  /** Ends the open line at the edge of a block. */
  const endLine = () => {
    flush();
    top().soft = false;
  };
  /** Ends the open line and asks for a blank line before the next. */
  const blank = () => {
    endLine();
    top().gap = true;
  };

  const closeCell = () => {
    const row = rows[rows.length - 1];
    if (!row?.cellOpen) {
      return;
    }
    flush();
    row.cells.push(frames.pop()!);
    row.cellOpen = false;
    // A text size stated inside the cell ends with the cell.
    while (sized.length > 0 && sized[sized.length - 1]!.frame > frames.length) {
      sized.pop();
    }
  };
  const closeRow = () => {
    const row = rows[rows.length - 1];
    if (!row) {
      return;
    }
    closeCell();
    rows.pop();
    const filled = row.cells.filter((cell) => cell.lines.length > 0);
    if (filled.length === 0) {
      return;
    }
    const parent = top();
    endLine();
    // A cell of a row is one block of a line or two; the first cell with words is one line (a label, or a value like the others).
    const oneBlock = (cell: Frame) => cell.lines.length <= MAX_CELL_LINES && cell.lines.every((line, index) => !line.blank && (index === 0 || line.soft));
    if (filled.length >= 2 && filled[0]!.lines.length === 1 && filled.every(oneBlock)) {
      // A row of cells: one line. An empty cell keeps its place, and a cell that spans columns takes theirs.
      const cells: string[] = [];
      let depth = 0;
      for (const cell of row.cells) {
        cells.push(cell.lines.map((line) => line.text).join(" "));
        for (let extra = 1; extra < cell.span; extra++) {
          cells.push("");
        }
        depth = Math.max(depth, cell.lines[0]?.quote ?? 0);
      }
      push(parent, cells.join(" | ").replace(/\s+/g, " ").trim(), depth);
      rowLines += 1;
      return;
    }
    // Layout: a cell with more than a line, or one of several, is a block of its own.
    for (const cell of filled) {
      const block = filled.length > 1 || cell.lines.length > 1 || cell.lead;
      if (block) {
        parent.gap = true;
      }
      for (const line of cell.lines) {
        if (line.blank) {
          parent.gap = true;
        } else {
          push(parent, line.text, line.quote);
        }
      }
      if (block || cell.gap) {
        parent.gap = true;
      }
    }
  };

  const length = html.length;
  let at = 0;
  while (at < length) {
    const lt = html.indexOf("<", at);
    const textEnd = lt === -1 ? length : lt;
    if (textEnd > at && !gone && !muted()) {
      top().open += decodeEntities(html.slice(at, textEnd));
    }
    if (lt === -1) {
      break;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 33 || next === 63) {
      // A comment, a doctype or a processing instruction.
      if (html.startsWith("<!--", lt)) {
        const empty = html.startsWith("<!-->", lt) ? 5 : html.startsWith("<!--->", lt) ? 6 : 0;
        const close = empty ? -1 : html.indexOf("-->", lt + 4);
        at = empty ? lt + empty : close === -1 ? length : close + 3;
      } else {
        const close = html.indexOf(">", lt);
        at = close === -1 ? length : close + 1;
      }
      continue;
    }
    if (!isLetter(next) && !(next === 47 && isLetter(html.charCodeAt(lt + 2)))) {
      // A bare "<" in running words.
      if (!gone && !muted()) {
        top().open += "<";
      }
      at = lt + 1;
      continue;
    }
    const tag = readTag(html, lt, quotes);
    if (!tag) {
      // A tag the source never closes: nothing after it is text.
      break;
    }
    at = tag.end;
    const { name, closing } = tag;
    if (!closing && RAW.has(name)) {
      at = afterRaw(html, name, at);
      continue;
    }
    const empty = VOID.has(name);
    const hides = tag.hidden || (tag.style !== "" && HIDING.test(tag.style));

    if (gone) {
      if (empty) {
        continue;
      }
      // A piece out of sight ends with its own closing tag, or with the cell, row or table it stands in.
      const level = gone.outer.length === 0;
      if (!closing) {
        const implied = level && ((isCell(gone.name) && (isCell(name) || name === "tr")) || (gone.name === "tr" && name === "tr"));
        if (!implied) {
          if (name === gone.name) {
            gone.depth += 1;
          }
          if (name === "table") {
            gone.outer.push([gone.row, gone.cell]);
            gone.row = false;
            gone.cell = false;
          } else if (name === "tr") {
            gone.row = true;
            gone.cell = false;
          } else if (isCell(name)) {
            gone.row = true;
            gone.cell = true;
          }
          continue;
        }
      } else if (name === gone.name && (gone.depth -= 1) > 0) {
        continue;
      } else if (name === gone.name) {
        gone = null;
        continue;
      } else if (name === "table" && !level) {
        [gone.row, gone.cell] = gone.outer.pop()!;
        continue;
      } else if (name === "tr" && gone.row) {
        gone.row = false;
        gone.cell = false;
        continue;
      } else if (isCell(name) && gone.cell) {
        gone.cell = false;
        continue;
      } else if (name !== "table" && name !== "tr" && !isCell(name)) {
        continue;
      }
      gone = null;
    }
    if (hides && !closing) {
      if (!empty) {
        gone = { name, depth: 1, row: false, cell: false, outer: [] };
      }
      continue;
    }

    if (closing) {
      const last = sized[sized.length - 1];
      if (last && last.name === name && (last.depth -= 1) === 0) {
        sized.pop();
      }
    }

    const structured = tables > 0 && tables <= MAX_TABLE_DEPTH;
    if (name === "br") {
      const frame = top();
      if (flush()) {
        frame.soft = true;
      } else {
        // A second break, or a break after a block: a blank line.
        frame.soft = false;
        frame.gap = true;
      }
    } else if (name === "table") {
      if (closing) {
        if (tables > 0) {
          while (rows.length > 0 && rows[rows.length - 1]!.depth >= tables) {
            closeRow();
          }
          tables -= 1;
        }
        blank();
      } else {
        blank();
        tables += 1;
      }
    } else if (name === "tr" && structured) {
      const row = rows[rows.length - 1];
      if (row && row.depth === tables) {
        // Its own closing tag, or a new row after one left open.
        closeRow();
      }
      if (!closing) {
        endLine();
        rows.push({ depth: tables, cells: [], cellOpen: false });
      }
    } else if (isCell(name) && structured) {
      let row = rows[rows.length - 1];
      if (closing) {
        if (row && row.depth === tables) {
          closeCell();
        }
      } else {
        if (!row || row.depth < tables) {
          // A cell with no row: the row is implied.
          endLine();
          row = { depth: tables, cells: [], cellOpen: false };
          rows.push(row);
        }
        closeCell();
        row.cellOpen = true;
        frames.push(newFrame(tag.span));
      }
    } else if (name === "li") {
      endLine();
      top().bullet = !closing;
    } else if (name === "blockquote") {
      if (closing) {
        endLine();
        quote = Math.max(0, quote - 1);
        top().gap = true;
      } else {
        blank();
        quote += 1;
      }
    } else if (PARAGRAPH.has(name)) {
      blank();
    } else if (BLOCK.has(name)) {
      endLine();
    }

    if (!closing && !empty) {
      const size = tag.style === "" ? null : FONT_SIZE.exec(tag.style);
      const nothing = size ? NOTHING.test(size[1]!.trim()) : muted();
      const last = sized[sized.length - 1];
      if (nothing !== muted()) {
        sized.push({ name, depth: 1, nothing, frame: frames.length });
      } else if (last && last.name === name) {
        last.depth += 1;
      }
    }
  }
  // Whatever the source left open ends here.
  while (rows.length > 0) {
    closeRow();
  }
  flush();
  const text = frames[0]!.lines.map((line) => (line.blank ? "" : `${"> ".repeat(Math.min(line.quote, MAX_QUOTE_MARKS))}${line.text}`)).join("\n");
  return { text, rows: rowLines };
}

/** HTML read as text: lines, rows of cells, list items, quoted messages; nothing the page hides. */
export function htmlToText(html: string): string {
  return layOut(html).text;
}

/** Tags stripped, paragraph boundaries kept, entities restored: for the XML of office files. */
export function xmlToText(xml: string, paragraphEnd: RegExp): string {
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

/**
 * The body of a message as every reader of it gets it. A mail in running
 * words is read from its plain part. A mail laid out as rows of cells is
 * read from its HTML part, which keeps them; so is one whose plain part is
 * a stub ("View this email in your browser") or empty.
 */
export function mailBodyText(record: { text?: string; html?: string }): string {
  const plain = record.text?.trim() ? record.text : undefined;
  if (!record.html) {
    return plain ?? "";
  }
  const laidOut = layOut(record.html);
  if (plain === undefined) {
    return laidOut.text;
  }
  return laidOut.rows > 0 || plain.trim().length < 0.5 * laidOut.text.length ? laidOut.text : plain;
}
