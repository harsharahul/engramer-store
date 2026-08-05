/**
 * The barcode on North American driver's licences (AAMVA card design
 * standard).
 *
 * The card states its own expiry as a structured field, so nothing has to be
 * guessed from recognized characters. This reads the already-decoded payload
 * string; turning pixels into that string is barcode.ts, which keeps this half
 * pure and testable.
 *
 * Issuers disagree about date order: United States cards write MMDDCCYY and
 * Canadian ones CCYYMMDD. Rather than depend on a table of issuer numbers,
 * which would silently produce wrong dates wherever the table was incomplete,
 * each field is read both ways and kept only if exactly one reading is a real
 * date. For every date this application will ever see, only one can be: a
 * four-digit year at the front leaves a two-digit "month" of 19 or 20, and a
 * four-digit year at the back leaves a plausible month. A field where both
 * readings work is genuinely undecidable and is skipped rather than guessed.
 *
 * The date of birth is deliberately not stored. No rule here needs it, and it
 * is the most sensitive field on the card.
 */

import { type Fact, factId, maskTail } from "./facts";

/** The header every compliant record opens with, followed by the issuer id. */
const HEADER = /ANSI\s*(\d{6})/;

/** Years outside this range are not a date on a licence, they are a misread. */
const EARLIEST_YEAR = 1900;
const LATEST_YEAR = 2100;

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < EARLIEST_YEAR || year > LATEST_YEAR) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Reads an eight-digit AAMVA date, or returns null when the digits do not
 * settle the question. Both orderings are tried and exactly one must work.
 */
export function aamvaDate(digits: string): string | null {
  if (!/^\d{8}$/.test(digits)) {
    return null;
  }
  const monthFirst = isRealDate(
    Number(digits.slice(4, 8)),
    Number(digits.slice(0, 2)),
    Number(digits.slice(2, 4)),
  )
    ? iso(Number(digits.slice(4, 8)), Number(digits.slice(0, 2)), Number(digits.slice(2, 4)))
    : null;
  const yearFirst = isRealDate(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)),
    Number(digits.slice(6, 8)),
  )
    ? iso(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)))
    : null;

  if (monthFirst && yearFirst) {
    // Undecidable, which in practice means the digits are not a date at all.
    return monthFirst === yearFirst ? monthFirst : null;
  }
  return monthFirst ?? yearFirst;
}

/** Three-letter element identifiers, and what this reads out of them. */
const EXPIRY = "DBA";
const ISSUED = "DBD";
const LICENCE_NUMBER = "DAQ";

/** Every element in the payload, by its identifier. */
function elements(payload: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of payload.split(/[\n\r]+/)) {
    const line = raw.trim();
    const match = /^([A-Z]{3})(.*)$/.exec(line);
    if (!match || line.startsWith("ANSI")) {
      continue;
    }
    if (!found.has(match[1]!)) {
      found.set(match[1]!, match[2]!.trim());
    }
  }
  return found;
}

/**
 * The facts a licence barcode yields. An unreadable field is skipped on its
 * own; one bad element does not discard the rest, because unlike a
 * machine-readable zone there is no checksum tying the fields together.
 */
export function aamvaFacts(payload: string): Fact[] {
  if (!payload || !HEADER.test(payload)) {
    return [];
  }
  const found = elements(payload);
  const facts: Fact[] = [];
  // Identity cards share this format. Distinguishing them means reading the
  // subfile designators, which is not worth doing until something needs it.
  const document = "drivers-license";

  for (const [code, kind] of [
    [EXPIRY, "expiry"],
    [ISSUED, "issued"],
  ] as const) {
    const date = aamvaDate(found.get(code) ?? "");
    if (date) {
      facts.push({
        id: factId(kind, date),
        kind,
        document,
        value: date,
        source: "barcode",
        confidence: 1,
      });
    }
  }

  const number = found.get(LICENCE_NUMBER);
  if (number) {
    facts.push({
      id: factId("identifier", number),
      kind: "identifier",
      document,
      value: number,
      masked: maskTail(number),
      source: "barcode",
      confidence: 1,
    });
  }

  return facts;
}
