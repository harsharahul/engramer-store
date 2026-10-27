/**
 * An email as a PDF: the headers, the body as text, and the list of files
 * that came with it, on US Letter pages in the standard Helvetica font.
 *
 * Plain layout by design for now: the email's own styling and images need
 * a real renderer, which the Mac and iPhone apps will bring. Characters the
 * standard font cannot draw become "?", and the PDF says so on its last
 * page rather than dropping them quietly.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatBytes } from "../format";
import { htmlToText } from "../intel/extract";
import type { EmailRecord } from "./record";

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const BODY_SIZE = 10.5;
const BODY_LEADING = 14;
const SUBJECT_SIZE = 16;
const SUBJECT_LEADING = 21;
const LABEL_SIZE = 9.5;
const LABEL_WIDTH = 46;
const TEXT_WIDTH = PAGE.width - 2 * MARGIN;
const MUTED = rgb(0.4, 0.4, 0.4);
const REPLACED_NOTE = "Some characters could not be shown in this PDF and appear as ?.";

/** Keeps what the font can draw and replaces the rest, remembering whether it had to. */
function makeCleaner(fonts: PDFFont[]) {
  const drawable = new Map<string, boolean>();
  const state = { replaced: false };
  const clean = (text: string): string => {
    let out = "";
    for (const char of text.replace(/\t/g, "    ")) {
      if (char < " ") {
        out += " ";
        continue;
      }
      let ok = drawable.get(char);
      if (ok === undefined) {
        ok = fonts.every((font) => {
          try {
            font.encodeText(char);
            return true;
          } catch {
            return false;
          }
        });
        drawable.set(char, ok);
      }
      if (ok) {
        out += char;
      } else {
        out += "?";
        state.replaced = true;
      }
    }
    return out;
  };
  return { clean, state };
}

/** Breaks one paragraph into lines that fit `width`, splitting words only when one is wider than a line. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (line: string) => font.widthOfTextAtSize(line, size) <= width;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/ +/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    line = "";
    let rest = word;
    while (!fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) {
        cut--;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  lines.push(line);
  return lines;
}

/** The Date header as the email printed it, or the date it carries. */
function printedDate(record: EmailRecord): string {
  const header = /^date:[ \t]*(.+)$/im.exec(record.headers)?.[1]?.trim();
  if (header) {
    return header;
  }
  return record.date ? new Date(record.date).toUTCString() : "Unknown";
}

export async function emailToPdf(
  record: EmailRecord,
): Promise<{ bytes: Uint8Array; replacedCharacters: boolean }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(record.subject || "(no subject)");
  pdf.setProducer("Engram Store");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { clean, state } = makeCleaner([regular, bold]);

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  const ensure = (height: number) => {
    if (y - height < MARGIN) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
  };
  const line = (text: string, opts: { font?: PDFFont; size?: number; leading?: number; x?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const leading = opts.leading ?? BODY_LEADING;
    ensure(leading);
    y -= leading;
    page.drawText(text, {
      x: opts.x ?? MARGIN,
      y,
      size: opts.size ?? BODY_SIZE,
      font: opts.font ?? regular,
      ...(opts.color ? { color: opts.color } : {}),
    });
  };
  const paragraph = (text: string, opts: { font?: PDFFont; size?: number; leading?: number } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    for (const row of wrap(clean(text), font, size, TEXT_WIDTH)) {
      line(row, opts);
    }
  };
  const field = (label: string, value: string) => {
    const rows = wrap(clean(value), regular, BODY_SIZE, TEXT_WIDTH - LABEL_WIDTH);
    rows.forEach((row, i) => {
      ensure(BODY_LEADING);
      y -= BODY_LEADING;
      if (i === 0) {
        page.drawText(label, { x: MARGIN, y, size: LABEL_SIZE, font: bold, color: MUTED });
      }
      page.drawText(row, { x: MARGIN + LABEL_WIDTH, y, size: BODY_SIZE, font: regular });
    });
  };

  paragraph(record.subject || "(no subject)", { font: bold, size: SUBJECT_SIZE, leading: SUBJECT_LEADING });
  y -= 6;
  const sender =
    record.from.name && record.from.name !== record.from.address
      ? `${record.from.name} <${record.from.address}>`
      : record.from.address || "Unknown sender";
  field("From", sender);
  if (record.to.length > 0) {
    field("To", record.to.join(", "));
  }
  if (record.cc.length > 0) {
    field("Cc", record.cc.join(", "));
  }
  field("Date", printedDate(record));
  y -= 10;
  ensure(1);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE.width - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 6;

  const body = record.text ?? (record.html ? htmlToText(record.html) : "");
  for (const text of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (text.trim() === "") {
      y -= BODY_LEADING / 2;
      continue;
    }
    paragraph(text);
  }

  if (record.attachments.length > 0) {
    y -= BODY_LEADING;
    line("Attachments", { font: bold });
    for (const attachment of record.attachments) {
      paragraph(`${attachment.name} (${attachment.mime}, ${formatBytes(attachment.size)})`);
    }
  }

  if (state.replaced) {
    y -= BODY_LEADING;
    line(REPLACED_NOTE, { size: LABEL_SIZE, color: MUTED });
  }

  return { bytes: await pdf.save(), replacedCharacters: state.replaced };
}
