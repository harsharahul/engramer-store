/**
 * The parts of a message that are not its own words.
 *
 * A reply quotes the message it answers; a forward carries another message
 * whole; a sender's footer holds offers, addresses and the way to
 * unsubscribe. A date or an amount there is not what the message says:
 *
 * - quoted text is read by no reader;
 * - a forwarded message is read for the dates and amounts it writes out (a
 *   booking forwarded to oneself), and not for days said in words, which
 *   were said on another day;
 * - a footer is read by no reader.
 *
 * This module only says where those parts are. Each reader decides what to
 * leave out, with `withoutZones`, which blanks a part and keeps every
 * place in the text true.
 */

export interface Span {
  at: number;
  end: number;
}

export interface Zones {
  /** What the message quotes: lines that start with ">", and all that follows "On ... wrote:". */
  quoted: Span[];
  /** A message carried whole, from the line that says so. */
  forwarded?: Span;
  /** The sender's footer, from its first mark to the end of the message's own words. */
  footer?: Span;
}

/** A reply's quoted message starts here: "On Mon, 9 Nov 2026, Alex wrote:". */
const QUOTE_HEADER = /^On\s.{1,200}\bwrote:\s*$/im;
/** A forward's separator line, as mail programs write it. */
const FORWARD_LINE = /^[ \t]*[-_]*[ \t]*(?:forwarded message|original message|begin forwarded message:)/im;
/** A forwarded message starts at a "From:" line with its "Sent:" or "Date:" line close below. */
const FORWARD_HEADER =
  /^\*?From:\*?[^\n]*\n(?:[^\n]*\n){0,3}?\*?(?:Sent|Date):|^\*?(?:Sent|Date):\*?[^\n]*\n(?:[^\n]*\n){0,3}?\*?From:/im;
/** Lines that start with ">", one under the other. */
const QUOTED_LINES = /^>[^\n]*(?:\n>[^\n]*)*/gm;

/** Words only a footer uses: the footer starts at the line they stand on. */
const FOOTER_ONLY = /\bunsubscribe\b|\byou(?:'re| are| have)? ?receiv(?:ed|ing) this (?:e-?mail|message)\b|\bmanage (?:your )?(?:e-?mail |mail |notification )?preferences\b|\ball rights reserved\b|©|\bregistered office\b/i;
/** Words a footer uses, and a body sometimes: the footer starts at the words themselves. */
const FOOTER_OR_BODY = /\bprivacy policy\b|\bterms (?:and|&) conditions\b/i;
const FOOTER_MARK = new RegExp(`${FOOTER_ONLY.source}|${FOOTER_OR_BODY.source}`, "gi");
/** One mark alone starts a footer only in the last two fifths of a message. */
const FOOTER_SHARE = 0.4;
/** Two marks of a footer start it earlier (a long footer under a short message), never in the first quarter. */
const FOOTER_FLOOR = 0.25;
/** How many marks are looked at. */
const MARKS_SEEN = 40;

/** Where a message quotes, forwards, and ends in a footer. */
export function zonesOf(text: string): Zones {
  const quoteAt = QUOTE_HEADER.exec(text)?.index;
  const forwardAt = [FORWARD_LINE, FORWARD_HEADER]
    .map((form) => form.exec(text)?.index)
    .filter((at): at is number => at !== undefined)
    .sort((a, b) => a - b)[0];
  // The message's own words end where it starts to quote.
  const own = quoteAt ?? text.length;

  const quoted: Span[] = [];
  for (const run of text.matchAll(QUOTED_LINES)) {
    if (run.index < own) {
      quoted.push({ at: run.index, end: Math.min(run.index + run[0].length, own) });
    }
  }
  if (quoteAt !== undefined) {
    quoted.push({ at: quoteAt, end: text.length });
  }
  const zones: Zones = { quoted };
  if (forwardAt !== undefined && forwardAt < own) {
    zones.forwarded = { at: forwardAt, end: own };
  }

  // A footer, in the message's own words. One mark alone starts it in the
  // last two fifths: a mark near the top, or a word a person writes in a
  // short note, is no footer. A mark only a footer uses, with another mark
  // after it, starts it at its line from the first quarter on.
  const late = Math.floor(own * (1 - FOOTER_SHARE));
  const early = Math.floor(own * FOOTER_FLOOR);
  const marks: { at: number; line: number; words: string; only: boolean }[] = [];
  FOOTER_MARK.lastIndex = early;
  for (let mark = FOOTER_MARK.exec(text); mark && mark.index < own && marks.length < MARKS_SEEN; mark = FOOTER_MARK.exec(text)) {
    marks.push({ at: mark.index, line: text.lastIndexOf("\n", mark.index - 1) + 1, words: mark[0].toLowerCase(), only: FOOTER_ONLY.test(mark[0]) });
  }
  const starts: number[] = [];
  const block = marks.find((mark, index) => mark.only && mark.line >= early && marks.slice(index + 1).some((other) => other.words !== mark.words));
  if (block) {
    starts.push(block.line);
  }
  const alone = marks.find((mark) => mark.at >= late);
  if (alone) {
    starts.push(alone.only && alone.line >= late ? alone.line : alone.at);
  }
  if (starts.length > 0) {
    zones.footer = { at: Math.min(...starts), end: own };
  }
  return zones;
}

/** The text with these parts blanked: every character but a line break becomes a space, so every place stays true. */
export function withoutZones(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) {
    return text;
  }
  let out = "";
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.at - b.at)) {
    if (span.end <= at) {
      continue;
    }
    const from = Math.max(span.at, at);
    out += text.slice(at, from) + text.slice(from, span.end).replace(/[^\n]/g, " ");
    at = span.end;
  }
  return out + text.slice(at);
}
