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
const DAY_FIRST_NAMED = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/;
const MONTH_FIRST_NAMED = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/;
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
export function parseDate(text: string, order?: DateOrder): ParsedDate | null {
  if (!text) {
    return null;
  }

  const iso = ISO.exec(text);
  if (iso) {
    const built = build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (built) {
      return { iso: built, ambiguous: false };
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
    // Both readings are possible. Month-first is produced so the confirmation
    // card has something to show; the flag is what stops it being acted on.
    const built = underOrder(a, b, c, "mdy") ?? underOrder(a, b, c, "dmy");
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
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar days from today, negative once the date has passed. */
export function daysUntil(iso: string, now: number): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) {
    return Number.NaN;
  }
  const target = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - start) / DAY_MS);
}
