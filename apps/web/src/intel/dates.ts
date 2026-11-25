/**
 * Reading a date out of a document, and admitting when it cannot be known.
 *
 * 03/04/2028 is the 3rd of April or the 4th of March depending on where the
 * document was printed, and there is no way to tell from the digits. Guessing
 * is wrong half the time, silently, on exactly the kind of value someone will
 * rely on. So an unresolvable date still produces a reading, because the
 * confirmation card needs something to show, and carries `ambiguous` so that
 * nothing acts on it until a person has said which one it is.
 *
 * Where the issuer is known the order is passed in rather than inferred: a
 * driver's licence barcode names its jurisdiction, so its dates are not
 * ambiguous even when the digits alone would be.
 *
 * Everything works in UTC. Building dates in local time would shift every
 * result back a day for anyone west of Greenwich.
 */

export type DateOrder = "mdy" | "dmy" | "ymd";

export interface ParsedDate {
  /** YYYY-MM-DD. */
  iso: string;
  /** The digits could be read two ways and the document did not say which. */
  ambiguous: boolean;
  /** The text printed no year: this is the next such day after it was written. */
  assumedYear?: true;
}

/** What a reader may know about the text beyond its words. */
export interface DateContext {
  /** The issuer's convention for numeric dates, where it is known. */
  order?: DateOrder;
  /** When the text was written (a message's own date). Only with this is a date with no year read. */
  writtenAt?: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// The year-first written form United States government documents use: an
// benefits statement prints "Benefit End Date: 2027 October 19". A named month and a
// four-digit year leave nothing to misread.
const YEAR_FIRST_NAMED = /\b(\d{4})\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/;
// A number followed by a colon is a clock, never a year: "November 12, 10:30"
// names no year, and reading one out of its hour would say 2010.
const DAY_FIRST_NAMED = /\b(\d{1,2})(?:(?:st|nd|rd|th)\s+of|(?:st|nd|rd|th)?)\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b(?!:\d)/;
const MONTH_FIRST_NAMED = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b(?!:\d)/;
// A month and a day with no year, as a message writes them ("Thursday,
// November 12", "Thu 12 Nov"). The month is capitalised and is a month's
// whole name or its usual short form; the weekday, when written, is kept so
// it can be checked against the day.
const WEEKDAY = "(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?";
const MONTH_DAY = new RegExp(`\\b${WEEKDAY}([A-Z][a-z]{2,8})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![\\d/:-]|\\.\\d)`, "g");
// The last day of a range ("5-7 June") is not the day it starts.
// "the 5th of December" says the same day with "of".
const DAY_MONTH = new RegExp(`(?<!\\d[-–/.])\\b${WEEKDAY}(\\d{1,2})(?:(?:st|nd|rd|th)\\s+of|(?:st|nd|rd|th)?)\\s+([A-Z][a-z]{2,8})\\b`, "g");
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Year-first numeric only reads one way: nobody writes year, day, month.
const YEAR_FIRST_NUMERIC = /\b(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/;
const NUMERIC = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/;
const COMPACT = /\b(\d{8})\b/;

/**
 * Two-digit years. A document expiring in "29" means 2029, and one issued in
 * "85" means 1985; nothing in this application deals in dates far enough out
 * for the split to be worth agonizing over.
 */
function expandYear(raw: string): number {
  const value = Number(raw);
  if (raw.length === 4) {
    return value;
  }
  return value <= 69 ? 2000 + value : 1900 + value;
}

function monthFromName(word: string): number | null {
  const lower = word.toLowerCase();
  if (lower.length < 3) {
    return null;
  }
  const index = MONTHS.findIndex((month) => month.startsWith(lower.slice(0, Math.min(lower.length, month.length))));
  return index === -1 ? null : index + 1;
}

/**
 * Builds the date, and rejects one that does not exist.
 *
 * The round trip is what matters: Date.UTC happily turns the 31st of February
 * into the 2nd of March, which would silently move a deadline rather than
 * report that the document could not be read.
 */
/** A month written out or in its usual short form ("Nov", "Sept"), and nothing that only starts like one. */
function monthExactly(word: string): number | null {
  const lower = word.toLowerCase();
  const index = MONTHS.findIndex((month) => lower === month || lower === month.slice(0, 3) || (month === "september" && lower === "sept"));
  return index === -1 ? null : index + 1;
}

/**
 * The first day with this month and number on or after the day the text was
 * written, when that is at most eleven months on: a day just past is last
 * week's, not next year's. The sender's day may be a day behind this
 * clock's, so the day before counts as the day it was written.
 */
function nextSuchDay(month: number, day: number, weekday: string | undefined, writtenAt: number): string | null {
  const written = new Date(writtenAt);
  const from = Date.UTC(written.getUTCFullYear(), written.getUTCMonth(), written.getUTCDate() - 1);
  const until = Date.UTC(written.getUTCFullYear(), written.getUTCMonth() + 11, written.getUTCDate());
  for (const year of [written.getUTCFullYear() - 1, written.getUTCFullYear(), written.getUTCFullYear() + 1]) {
    const iso = build(year, month, day);
    const at = Date.UTC(year, month - 1, day);
    if (!iso || at < from) {
      continue;
    }
    if (at > until) {
      return null;
    }
    return weekday === undefined || WEEKDAYS[new Date(at).getUTCDay()] === weekday.toLowerCase() ? iso : null;
  }
  return null;
}

function build(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Reads a numeric triple under one specific ordering. */
function underOrder(a: string, b: string, c: string, order: DateOrder): string | null {
  if (order === "ymd") {
    return build(expandYear(a), Number(b), Number(c));
  }
  const year = expandYear(c);
  return order === "mdy" ? build(year, Number(a), Number(b)) : build(year, Number(b), Number(a));
}

/**
 * Finds the first date in a piece of text.
 *
 * `order` is the issuer's convention where it is known. It is tried first, and
 * only falls back to inference if that reading produces a date that does not
 * exist, so a malformed field cannot be turned into a plausible wrong answer.
 */
export function parseDate(text: string, given?: DateOrder | DateContext): ParsedDate | null {
  if (!text) {
    return null;
  }
  const context: DateContext = typeof given === "string" ? { order: given } : (given ?? {});
  return datedIn(text, context.order) ?? (context.writtenAt === undefined ? null : undatedIn(text, context.writtenAt));
}

// Each form a full date is written in, most certain first, ready to be
// matched again and again across a text.
const DATED_FORMS = [ISO, YEAR_FIRST_NAMED, DAY_FIRST_NAMED, MONTH_FIRST_NAMED, YEAR_FIRST_NUMERIC, NUMERIC].map(
  (form) => new RegExp(form.source, `${form.flags}g`),
);

export interface FoundDate {
  /** Where it starts and ends in the text. */
  at: number;
  end: number;
  date: ParsedDate;
}

/**
 * Every place in a text where a form's words read as a date. Words that
 * have the form's shape and are no date ("00 due 30": a number, a word, a
 * number) must not hide a date that begins inside them, so the search then
 * moves on by one character, not past them.
 */
function readings(form: RegExp, text: string, read: (words: string) => ParsedDate | null): FoundDate[] {
  const found: FoundDate[] = [];
  // Its own copy: the reader may use the same form, and a shared one would
  // carry this search's place into the reader's.
  const walk = new RegExp(form.source, form.flags);
  for (let match = walk.exec(text); match; match = walk.exec(text)) {
    const date = read(match[0]);
    if (date) {
      found.push({ at: match.index, end: match.index + match[0].length, date });
    } else {
      walk.lastIndex = match.index + 1;
    }
  }
  return found;
}

/**
 * Every date in a text, in the order they stand, none overlapping another.
 *
 * `parseDate` answers "which date does this label mean" and reads one; this
 * answers "which dates does this document hold". Each is read exactly as
 * `parseDate` would read it alone. A date with no year is found only when
 * the context says when the text was written, and never inside a date that
 * states its year.
 */
export function findDates(text: string, context: DateContext = {}): FoundDate[] {
  const dated: (FoundDate & { rank: number })[] = [];
  DATED_FORMS.forEach((form, rank) => {
    for (const hit of readings(form, text, (words) => datedIn(words, context.order))) {
      dated.push({ ...hit, rank });
    }
  });
  // In the order they stand, each kept only when it starts past the last
  // one kept: one pass, however long the text.
  const placed: FoundDate[] = [];
  let end = -1;
  for (const { rank: _rank, ...hit } of dated.sort((a, b) => a.at - b.at || a.rank - b.rank)) {
    if (hit.at >= end) {
      placed.push(hit);
      end = hit.end;
    }
  }
  const { writtenAt } = context;
  if (writtenAt === undefined) {
    return placed;
  }
  const undated: FoundDate[] = [];
  for (const form of [MONTH_DAY, DAY_MONTH]) {
    undated.push(...readings(form, text, (words) => undatedIn(words, writtenAt)));
  }
  // A month and a day inside a date that states its year is that date, and
  // two forms that read the same words are one date.
  const stated = placed.length;
  let next = 0;
  end = -1;
  for (const hit of undated.sort((a, b) => a.at - b.at)) {
    while (next < stated && placed[next]!.end <= hit.at) {
      next += 1;
    }
    const taken = next < stated && placed[next]!.at < hit.end;
    if (!taken && hit.at >= end) {
      placed.push(hit);
      end = hit.end;
    }
  }
  return placed.sort((a, b) => a.at - b.at);
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_NAME = String.raw`(sunday|monday|tuesday|wednesday|thursday|friday|saturday)`;
/** "today", "tonight", "tomorrow". */
// Not "the day after tomorrow", "a week from today" or "a week tomorrow": another day.
const NEAR_DAY = /(?<!\b(?:after|from|week)\s)\b(today|tonight|tomorrow)\b/gi;
/** "this Saturday", "next Friday", "on Saturday"; "on Saturdays" is every week and no day. */
// Not "Monday's call" (said of a call, often past) or "on Monday, Wednesday and Friday" (a schedule).
const NAMED_WEEKDAY = new RegExp(
  String.raw`\b(this|next|on)\s+${WEEKDAY_NAME}\b(?!['\u2019]s)(?![ \t]*(?:,|and|or|to|through|-|\u2013)[ \t]*${WEEKDAY_NAME})`,
  "gi",
);
/** Words before a weekday in its sentence that say it was said of the past. */
const PAST_BEFORE =
  /\b(?:was|were|had|did|sent|went|met|discussed|spoke|talked|called|following|after|earned|paid|purchased|bought|ordered|received)\b[^.!?\n]*$/i;
/** A sentence about an offer: its days are a sale's, nobody's plan. */
const OFFER = /\b(?:offers?|on sale|discount|deals?|promo(?:tion)?|coupon|voucher|free (?:delivery|shipping)|points)\b|\d+\s?% off/i;
/** A sentence that says it is done. */
const DONE_AFTER = /^[^.!?\n]*\balready\b/i;
/** "Saturday the 5th". */
const WEEKDAY_THE_DAY = new RegExp(String.raw`\b${WEEKDAY_NAME}\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b`, "gi");
/** How far ahead "Saturday the 5th" is looked for. */
const WEEKDAY_THE_DAY_REACH = 42;
/** A reply's quoted message starts here: "On Mon, 9 Nov 2026, Alex wrote:". */
const QUOTE_HEADER = /^On\s.{1,200}\bwrote:\s*$/im;
/** A forward's separator line, as mail programs write it. */
const FORWARD_LINE = /^[ \t]*[-_]*[ \t]*(?:forwarded message|original message|begin forwarded message:)/im;
/** A forwarded message starts at a "From:" line with its "Sent:" or "Date:" line close below. */
const FORWARD_HEADER =
  /^\*?From:\*?[^\n]*\n(?:[^\n]*\n){0,3}?\*?(?:Sent|Date):|^\*?(?:Sent|Date):\*?[^\n]*\n(?:[^\n]*\n){0,3}?\*?From:/im;

/** The UTC day a number of days after a moment, as YYYY-MM-DD. */
function dayAfter(writtenAt: number, days: number): string {
  const written = new Date(writtenAt);
  return new Date(Date.UTC(written.getUTCFullYear(), written.getUTCMonth(), written.getUTCDate() + days)).toISOString().slice(0, 10);
}

/**
 * The days a message says in words, each read against the day it was sent
 * (its UTC day): "today" and "tonight" are that day, "tomorrow" the next,
 * "this Saturday" and "on Saturday" the coming one, "next Saturday" the one
 * a week after, and "Saturday the 5th" the next 5th that falls on a
 * Saturday, within six weeks. What a reply quotes or a message forwards
 * was said on another day, so the text stops where the quote starts, and a
 * line that begins with ">" is never read.
 */
export function findRelativeDays(text: string, writtenAt: number): { at: number; end: number; iso: string; relative: true }[] {
  const cut = Math.min(
    ...[QUOTE_HEADER, FORWARD_LINE, FORWARD_HEADER, /$(?![\s\S])/]
      .map((form) => form.exec(text)?.index)
      .filter((at): at is number => at !== undefined),
  );
  const own = text.slice(0, cut).replace(/^>[^\n]*/gm, (quoted) => " ".repeat(quoted.length));
  const today = new Date(writtenAt).getUTCDay();
  const ahead = (name: string) => (DAY_NAMES.indexOf(name.toLowerCase()) - today + 7) % 7;
  const days: { at: number; end: number; iso: string; relative: true }[] = [];
  /** The sentence a place in the text stands in, as its start and end. */
  const sentenceAround = (at: number, end: number) => {
    const start = Math.max(own.lastIndexOf(".", at - 1), own.lastIndexOf("!", at - 1), own.lastIndexOf("?", at - 1), own.lastIndexOf("\n", at - 1)) + 1;
    const stops = [".", "!", "?", "\n"].map((stop) => own.indexOf(stop, end)).filter((index) => index !== -1);
    return { start, stop: stops.length > 0 ? Math.min(...stops) : own.length };
  };
  /** Said of an offer, or of what was already done. */
  const notAPlan = (at: number, end: number) => {
    const { start, stop } = sentenceAround(at, end);
    return OFFER.test(own.slice(start, stop)) || PAST_BEFORE.test(own.slice(start, at)) || DONE_AFTER.test(own.slice(end));
  };
  for (const match of own.matchAll(NEAR_DAY)) {
    if (notAPlan(match.index, match.index + match[0].length)) {
      continue;
    }
    const word = match[1]!.toLowerCase();
    days.push({ at: match.index, end: match.index + match[0].length, iso: dayAfter(writtenAt, word === "tomorrow" ? 1 : 0), relative: true });
  }
  // "Friday the 5th" names its own day, found or not: "on Friday" there is not the coming Friday.
  const dayOfMonthSpans = [...own.matchAll(WEEKDAY_THE_DAY)].map((match) => ({ at: match.index, end: match.index + match[0].length }));
  for (const match of own.matchAll(NAMED_WEEKDAY)) {
    const at = match.index;
    const end = at + match[0].length;
    if (dayOfMonthSpans.some((span) => at < span.end && span.at < end) || notAPlan(at, end)) {
      continue;
    }
    const d = ahead(match[2]!);
    const which = match[1]!.toLowerCase();
    const offset = which === "this" ? d : which === "next" ? (d === 0 ? 7 : d + 7) : d === 0 ? 7 : d;
    days.push({ at: match.index, end: match.index + match[0].length, iso: dayAfter(writtenAt, offset), relative: true });
  }
  for (const match of own.matchAll(WEEKDAY_THE_DAY)) {
    if (notAPlan(match.index, match.index + match[0].length)) {
      continue;
    }
    const weekday = DAY_NAMES.indexOf(match[1]!.toLowerCase());
    const dayOfMonth = Number(match[2]);
    for (let offset = 0; offset <= WEEKDAY_THE_DAY_REACH; offset += 1) {
      const iso = dayAfter(writtenAt, offset);
      const date = new Date(`${iso}T00:00:00Z`);
      if (date.getUTCDate() === dayOfMonth && date.getUTCDay() === weekday) {
        days.push({ at: match.index, end: match.index + match[0].length, iso, relative: true });
        break;
      }
    }
  }
  // Where two readings overlap ("on Saturday the 5th"), the one that names
  // the day of the month is the exact one; it was added last.
  const placed: { at: number; end: number; iso: string; relative: true }[] = [];
  for (const day of [...days].reverse()) {
    if (!placed.some((held) => day.at < held.end && held.at < day.end)) {
      placed.push(day);
    }
  }
  return placed.sort((a, b) => a.at - b.at);
}

/** A month and a day with no year, read against when the text was written. */
function undatedIn(text: string, writtenAt: number): ParsedDate | null {
  // The first of each form whose word really is a month ("Thu 12" is not).
  const found: { at: number; weekday: string | undefined; month: number; day: number }[] = [];
  for (const match of text.matchAll(MONTH_DAY)) {
    const month = monthExactly(match[2]!);
    if (month !== null) {
      found.push({ at: match.index, weekday: match[1], month, day: Number(match[3]) });
      break;
    }
  }
  for (const match of text.matchAll(DAY_MONTH)) {
    const month = monthExactly(match[3]!);
    if (month !== null) {
      found.push({ at: match.index, weekday: match[1], month, day: Number(match[2]) });
      break;
    }
  }
  // Whichever stands first in the text is the one the words before it mean.
  const first = found.sort((a, b) => a.at - b.at)[0];
  if (!first) {
    return null;
  }
  const iso = nextSuchDay(first.month, first.day, first.weekday, writtenAt);
  return iso ? { iso, ambiguous: false, assumedYear: true } : null;
}

/** A date that states its year. */
function datedIn(text: string, order?: DateOrder): ParsedDate | null {

  const iso = ISO.exec(text);
  if (iso) {
    const built = build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (built) {
      return { iso: built, ambiguous: false };
    }
  }

  const yearFirst = YEAR_FIRST_NAMED.exec(text);
  if (yearFirst) {
    const month = monthFromName(yearFirst[2]!);
    if (month !== null) {
      const built = build(Number(yearFirst[1]), month, Number(yearFirst[3]));
      return built ? { iso: built, ambiguous: false } : null;
    }
  }

  const dayFirst = DAY_FIRST_NAMED.exec(text);
  if (dayFirst) {
    const month = monthFromName(dayFirst[2]!);
    if (month !== null) {
      const built = build(expandYear(dayFirst[3]!), month, Number(dayFirst[1]));
      // A named month cannot be misread as a day, so this is never ambiguous.
      // A date that does not exist is reported as unreadable, not shifted.
      return built ? { iso: built, ambiguous: false } : null;
    }
  }

  const monthFirst = MONTH_FIRST_NAMED.exec(text);
  if (monthFirst) {
    const month = monthFromName(monthFirst[1]!);
    if (month !== null) {
      const built = build(expandYear(monthFirst[3]!), month, Number(monthFirst[2]));
      return built ? { iso: built, ambiguous: false } : null;
    }
  }

  const yearNumeric = YEAR_FIRST_NUMERIC.exec(text);
  if (yearNumeric) {
    const built = build(Number(yearNumeric[1]), Number(yearNumeric[2]), Number(yearNumeric[3]));
    return built ? { iso: built, ambiguous: false } : null;
  }

  const numeric = NUMERIC.exec(text);
  if (numeric) {
    const [, a, b, c] = numeric as unknown as [string, string, string, string];
    if (order) {
      const stated = underOrder(a, b, c, order);
      if (stated) {
        return { iso: stated, ambiguous: false };
      }
    }
    const first = Number(a);
    const second = Number(b);
    // A number above twelve cannot be a month, which settles the order without
    // knowing anything about the document.
    if (first > 12 && second <= 12) {
      const built = underOrder(a, b, c, "dmy");
      return built ? { iso: built, ambiguous: false } : null;
    }
    if (second > 12 && first <= 12) {
      const built = underOrder(a, b, c, "mdy");
      return built ? { iso: built, ambiguous: false } : null;
    }
    if (first > 12 && second > 12) {
      return null;
    }
    // Both readings are possible. One is produced so the confirmation card
    // has something to show; the flag is what stops it being acted on. A
    // date written with dots is day first, as the countries that write
    // dates that way do; any other is month first.
    const dotted = numeric[0].includes(".");
    const built = underOrder(a, b, c, dotted ? "dmy" : "mdy") ?? underOrder(a, b, c, dotted ? "mdy" : "dmy");
    return built ? { iso: built, ambiguous: true } : null;
  }

  // Eight digits in a row are only read when the issuer's order is known.
  // Unanchored, they are as likely to be a reference number as a date.
  if (order) {
    const compact = COMPACT.exec(text);
    if (compact) {
      const digits = compact[1]!;
      const built =
        order === "ymd"
          ? build(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)))
          : order === "mdy"
            ? build(Number(digits.slice(4, 8)), Number(digits.slice(0, 2)), Number(digits.slice(2, 4)))
            : build(Number(digits.slice(4, 8)), Number(digits.slice(2, 4)), Number(digits.slice(0, 2)));
      if (built) {
        return { iso: built, ambiguous: false };
      }
    }
  }

  return null;
}

/**
 * The other way an ambiguous date could have been read, with the day and the
 * month exchanged. Null when the swap is not a real date, which is what makes
 * the reading unambiguous after all.
 *
 * This exists so a confirmation card can offer both readings as they are,
 * rather than asking someone to think in date formats.
 */
export function swappedReading(isoDate: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!parts) {
    return null;
  }
  const [, year, month, day] = parts as unknown as [string, string, string, string];
  return build(Number(year), Number(day), Number(month));
}

/**
 * A time of day, requiring a colon.
 *
 * Only a colon, deliberately: a dotted date like 12.30.2029 would otherwise
 * read as half past twelve, and four bare digits are as often a reference
 * number as a departure. A time that has to be found without a separator
 * belongs to whatever parser knows the format it is reading.
 */
const TIME = /\b(\d{1,2}):([0-5]\d)\s*([ap])\.?\s*m\.?/i;
const TIME_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
/**
 * A whole hour with its am or pm and no colon ("3pm", "11 am", "5 p.m.").
 * The marker is what makes it a clock: a bare number never is. A number that
 * ends a dotted or longer figure ("1.05 pm", "2027 pm") is left alone, and
 * so is a word that only begins with the marker ("10 Amsterdam").
 */
const TIME_HOUR = /(?<![\d.:,])\b(\d{1,2})\s?([ap])\.?m(?![A-Za-z])/i;
/**
 * An hour said with "o'clock", and what after it says which half of the day
 * ("9 o'clock in the evening", "8 o'clock tonight", "7 o'clock pm"). With
 * nothing after it the half of the day is unknown ("dinner at 7 o'clock"),
 * and no clock is read rather than a wrong one.
 */
const TIME_OCLOCK = /\b(\d{1,2})\s?o[’']?\s?clock\b(?:\s*(?:([ap])\.?m\.?(?![A-Za-z])|in the (morning|afternoon|evening)|(tonight|at night)))?/i;
/** Words before a length of time, not a time of day ("Running time: 2h30", "up to 2h"). */
const DURATION_BEFORE = String.raw`(?<!(?:duration|running time|flight time|journey time|travel time|takes|lasts|up to|dur[eé]e|about|approx\.?|around)[ \t]*:?[ \t]*)`;
/**
 * The hour written with an h ("15h00", "15h30"), as much of Europe writes it.
 * A bare "15h" is a clock only after a word that says when ("at 15h",
 * "from 9h"): "Room 15h" and "a 24h service" are not.
 */
const TIME_H = new RegExp(String.raw`${DURATION_BEFORE}(?<![\d.:,])\b([01]?\d|2[0-3])h([0-5]\d)(?![\dA-Za-z])`, "i");
const TIME_H_BARE = /\b(?:at|from|until|till|by|before|after|à|dès|vers)\s+([01]?\d|2[0-3])h(?![\dA-Za-z])/i;
/** Noon said in words. Midnight is not read: which day it closes is unclear. */
const TIME_NOON = /\b(?:noon|midday)\b/i;

/**
 * One end of a range: an hour, its minutes, its half of the day. Spaces
 * are bounded and never a line break, so a range stays on its line and a
 * long run of blanks costs nothing.
 */
const RANGE_END = String.raw`(\d{1,2})(?::([0-5]\d))?(?:[ \t]{0,2}([ap])\.?m\.?(?![A-Za-z]))?`;
/** Not after a month's name, a slash or a digit: "December 3 - 7:00 PM" and "5/12 - 7pm" are a day and a clock. */
const RANGE_NOT_AFTER = String.raw`(?<!(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[ \t]{1,3})(?<![\d.:,/\-])`;
/** "7-9pm", "7:00-9:00 PM", "11am to 1pm", "14:00 until 17:30". */
const RANGE_TO = new RegExp(
  String.raw`${RANGE_NOT_AFTER}\b${RANGE_END}([ \t]{0,3}(?:-|\u2013|to|until|till)[ \t]{0,3})${RANGE_END}(?![\dA-Za-z:])`,
  "i",
);
/** "between 10:00 and 14:00": "and" joins a range only after "between". */
const RANGE_BETWEEN = new RegExp(String.raw`\bbetween[ \t]{1,3}${RANGE_END}([ \t]{1,3}and[ \t]{1,3})${RANGE_END}(?![\dA-Za-z:])`, "i");
/** A dash with a space beside it. */
const SPACED_DASH = /[ \t][-\u2013]|[-\u2013][ \t]/;
/** How long a range may run when its start leaves its half of the day unsaid ("11-1pm"). */
const IMPLIED_SPAN_MINUTES = 6 * 60;

const minutesOf = (hour: number, minute: number) => hour * 60 + minute;
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** An hour in a half of the day, as minutes after midnight; null when the hour cannot be in that half. */
function inHalf(hour: number, minute: number, half: string | undefined): number | null {
  if (!half) {
    return hour <= 23 ? minutesOf(hour, minute) : null;
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  const pm = half.toLowerCase() === "p";
  return minutesOf(hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour, minute);
}

/**
 * The start and end of a range of hours, or null when the match is not one.
 * Two bare numbers ("7-9", pages, ages, a score) are not a range: the end
 * says its half of the day, or both ends carry minutes. A start that leaves
 * its half unsaid takes the end's ("7-9pm" is the evening), or the other
 * half when that would put it after the end ("11-1pm"), and then only for a
 * short span. A range that would end before it starts is none. A start
 * that is only a number ("3", no minutes, no half of the day) joins its end
 * only by an unspaced dash or a word ("7-9pm", "7 to 9pm"): "Room 3 - 7pm"
 * is a room and a clock.
 */
function rangeIn(match: RegExpExecArray): { start: string; end: string } | null {
  const [, h1, m1, half1, joined = "", h2, m2, half2] = match;
  if (!half2 && !(m1 && m2)) {
    return null;
  }
  if (!m1 && !half1 && SPACED_DASH.test(joined)) {
    return null;
  }
  const end = inHalf(Number(h2), Number(m2 ?? 0), half2);
  if (end === null) {
    return null;
  }
  let start = inHalf(Number(h1), Number(m1 ?? 0), half1 ?? half2);
  if (!half1 && half2 && start !== null && start >= end) {
    const other = half2.toLowerCase() === "p" ? "a" : "p";
    const earlier = inHalf(Number(h1), Number(m1 ?? 0), other);
    start = earlier !== null && earlier < end && end - earlier <= IMPLIED_SPAN_MINUTES ? earlier : null;
  }
  return start !== null && start < end ? { start: clockOf(start), end: clockOf(end) } : null;
}

/** The start of a range of hours that holds the given place in a text, if one does. */
function rangeAround(text: string, at: number): string | null {
  for (const form of RANGE_FORMS) {
    for (const match of text.matchAll(form)) {
      if (at >= match.index && at < match.index + match[0].length) {
        const range = rangeIn(match);
        if (range) {
          return range.start;
        }
      }
    }
  }
  return null;
}

/**
 * A local time of day as "HH:MM".
 *
 * Local to whatever the document is talking about, and deliberately not
 * converted to an instant: a departure printed on a ticket is the time at that
 * airport, and turning it into UTC without knowing the airport's zone would
 * produce an answer that looks precise and is hours wrong.
 */
export function parseTime(text: string): string | null {
  if (!text) {
    return null;
  }
  const pick = clockPick(text);
  if (!pick) {
    return null;
  }
  // A clock that is one end of a range ("9pm" in "7-9pm") stands for the
  // range, which is its start. A range elsewhere on the line (opening hours
  // after an appointment) takes nothing from the clock that was picked.
  return rangeAround(text, pick.at) ?? pick.time;
}

/** The clock a text states, in the order of the forms, with where it stands. */
function clockPick(text: string): { time: string; at: number } | null {
  const meridiem = TIME.exec(text);
  if (meridiem) {
    const raw = Number(meridiem[1]);
    if (raw < 1 || raw > 12) {
      return null;
    }
    const pm = meridiem[3]!.toLowerCase() === "p";
    const hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;
    return { time: `${String(hour).padStart(2, "0")}:${meridiem[2]}`, at: meridiem.index };
  }
  const plain = TIME_24.exec(text);
  if (plain) {
    return { time: `${String(Number(plain[1])).padStart(2, "0")}:${plain[2]}`, at: plain.index };
  }
  // After the colon forms, so a clock written with a colon always wins.
  const hourOnly = TIME_HOUR.exec(text);
  if (hourOnly) {
    const raw = Number(hourOnly[1]);
    if (raw < 1 || raw > 12) {
      return null;
    }
    const pm = hourOnly[2]!.toLowerCase() === "p";
    const hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;
    return { time: `${String(hour).padStart(2, "0")}:00`, at: hourOnly.index };
  }
  const oclock = TIME_OCLOCK.exec(text);
  if (oclock) {
    const raw = Number(oclock[1]);
    const half = (oclock[2] ?? "").toLowerCase();
    const part = (oclock[3] ?? "").toLowerCase();
    const pm = half === "p" || part === "afternoon" || part === "evening" || oclock[4] !== undefined;
    const am = half === "a" || part === "morning";
    if (raw >= 1 && raw <= 12 && (pm || am)) {
      const hour = raw === 12 ? (am ? 0 : 12) : pm ? raw + 12 : raw;
      return { time: `${String(hour).padStart(2, "0")}:00`, at: oclock.index };
    }
  }
  const withH = TIME_H.exec(text);
  if (withH) {
    return { time: `${String(Number(withH[1])).padStart(2, "0")}:${withH[2]}`, at: withH.index };
  }
  const bareH = TIME_H_BARE.exec(text);
  if (bareH) {
    return { time: `${String(Number(bareH[1])).padStart(2, "0")}:00`, at: bareH.index };
  }
  const noon = TIME_NOON.exec(text);
  if (noon) {
    return { time: "12:00", at: noon.index };
  }
  return null;
}

const CLOCK_FORMS = [TIME, TIME_24, TIME_HOUR, TIME_OCLOCK, TIME_H, TIME_H_BARE, TIME_NOON].map(
  (form) => new RegExp(form.source, `${form.flags}g`),
);

const RANGE_FORMS = [RANGE_BETWEEN, RANGE_TO].map((form) => new RegExp(form.source, `${form.flags}g`));

/**
 * Every clock in a text, in the order they stand, each read as `parseTime`
 * reads it alone. A range of hours is one clock, its start, with the end
 * kept beside it.
 */
export function findTimes(text: string): { at: number; end: number; time: string; endTime?: string }[] {
  const clocks: { at: number; end: number; time: string; endTime?: string; rank: number }[] = [];
  for (const form of RANGE_FORMS) {
    for (const match of text.matchAll(form)) {
      const range = rangeIn(match);
      if (range) {
        clocks.push({ at: match.index, end: match.index + match[0].length, time: range.start, endTime: range.end, rank: -1 });
      }
    }
  }
  CLOCK_FORMS.forEach((form, rank) => {
    for (const match of text.matchAll(form)) {
      const time = parseTime(match[0]);
      if (time) {
        clocks.push({ at: match.index, end: match.index + match[0].length, time, rank });
      }
    }
  });
  const placed: { at: number; end: number; time: string; endTime?: string }[] = [];
  let end = -1;
  for (const { rank: _rank, ...clock } of clocks.sort((a, b) => a.at - b.at || a.rank - b.rank)) {
    if (clock.at >= end) {
      placed.push(clock);
      end = clock.end;
    }
  }
  return placed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days from today, negative once the date has passed.
 *
 * Today is the device's own day. West of UTC the evening is already
 * tomorrow by the UTC clock, and counting from that day would call a bill
 * due tomorrow "today" and one due today overdue. Both days are laid on the
 * same UTC ruler only to count them, so a clock change never adds or drops
 * a day.
 */
export function daysUntil(iso: string, now: number): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) {
    return Number.NaN;
  }
  const target = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const today = new Date(now);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / DAY_MS);
}

/** Whether an ISO YYYY-MM-DD names a day that exists (no 13th month, no 31 February). */
export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}
