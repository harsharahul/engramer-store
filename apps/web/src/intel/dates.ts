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
const DAY_FIRST_NAMED = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b(?!:\d)/;
const MONTH_FIRST_NAMED = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b(?!:\d)/;
// A month and a day with no year, as a message writes them ("Thursday,
// November 12", "Thu 12 Nov"). The month is capitalised and is a month's
// whole name or its usual short form; the weekday, when written, is kept so
// it can be checked against the day.
const WEEKDAY = "(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?";
const MONTH_DAY = new RegExp(`\\b${WEEKDAY}([A-Z][a-z]{2,8})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![\\d/:-]|\\.\\d)`, "g");
// The last day of a range ("5-7 June") is not the day it starts.
const DAY_MONTH = new RegExp(`(?<!\\d[-–/.])\\b${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Z][a-z]{2,8})\\b`, "g");
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
  const meridiem = TIME.exec(text);
  if (meridiem) {
    const raw = Number(meridiem[1]);
    if (raw < 1 || raw > 12) {
      return null;
    }
    const pm = meridiem[3]!.toLowerCase() === "p";
    const hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;
    return `${String(hour).padStart(2, "0")}:${meridiem[2]}`;
  }
  const plain = TIME_24.exec(text);
  if (plain) {
    return `${String(Number(plain[1])).padStart(2, "0")}:${plain[2]}`;
  }
  // Last, so a clock written with a colon always wins.
  const hourOnly = TIME_HOUR.exec(text);
  if (hourOnly) {
    const raw = Number(hourOnly[1]);
    if (raw < 1 || raw > 12) {
      return null;
    }
    const pm = hourOnly[2]!.toLowerCase() === "p";
    const hour = raw === 12 ? (pm ? 12 : 0) : pm ? raw + 12 : raw;
    return `${String(hour).padStart(2, "0")}:00`;
  }
  return null;
}

const CLOCK_FORMS = [TIME, TIME_24, TIME_HOUR].map((form) => new RegExp(form.source, `${form.flags}g`));

/** Every clock in a text, in the order they stand, each read as `parseTime` reads it alone. */
export function findTimes(text: string): { at: number; end: number; time: string }[] {
  const clocks: { at: number; end: number; time: string; rank: number }[] = [];
  CLOCK_FORMS.forEach((form, rank) => {
    for (const match of text.matchAll(form)) {
      const time = parseTime(match[0]);
      if (time) {
        clocks.push({ at: match.index, end: match.index + match[0].length, time, rank });
      }
    }
  });
  const placed: { at: number; end: number; time: string }[] = [];
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
