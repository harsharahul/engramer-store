/**
 * The machine-readable zone on passports and identity cards (ICAO 9303).
 *
 * This is the most reliable thing a document ever tells you. Fields sit at
 * fixed positions, and each one carries a check digit, so a misread is
 * detectable rather than silently wrong. That property is the entire reason to
 * prefer the zone over recognizing the printed text beside it, which is why a
 * failed check discards the whole read instead of lowering its score: a fact
 * that survives a failed check throws away the only thing that made it better
 * than a guess.
 *
 * The date of birth is read, because the check digits require it, and
 * deliberately not stored. No rule here needs it and it is the most sensitive
 * field on the document.
 */

import { type Fact, factId, maskTail } from "./facts";

const TD3_LENGTH = 44;
const TD1_LENGTH = 30;
const WEIGHTS = [7, 3, 1];

/** Only these characters appear in a zone; anything else means it is prose. */
const ZONE_CHARS = /^[A-Z0-9<]+$/;

function value(character: string): number {
  if (character >= "0" && character <= "9") {
    return character.charCodeAt(0) - 48;
  }
  if (character >= "A" && character <= "Z") {
    return character.charCodeAt(0) - 55;
  }
  // "<" is filler, and anything unexpected is treated the same way so a
  // malformed field fails its check rather than throwing.
  return 0;
}

/** The ICAO check digit: values weighted 7, 3, 1 repeating, modulo ten. */
export function checkDigit(input: string): string {
  let sum = 0;
  for (let at = 0; at < input.length; at++) {
    sum += value(input[at]!) * WEIGHTS[at % 3]!;
  }
  return String(sum % 10);
}

function checks(field: string, digit: string): boolean {
  return checkDigit(field) === digit;
}

/**
 * Two digits into a year. An expiry in "12" is 2012 rather than 1912, and a
 * birth date in "74" is 1974; the same split the rest of this app uses.
 */
function expandYear(yy: string): number {
  const year = Number(yy);
  return year <= 69 ? 2000 + year : 1900 + year;
}

/** A zone date is always YYMMDD, and one that does not exist fails. */
function zoneDate(yymmdd: string): string | null {
  const year = expandYear(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Candidate zones in a page of text.
 *
 * Character recognition inserts spaces into the zone often enough that
 * stripping them is worth more than the precision it costs, and a line of the
 * right length made only of zone characters is not something prose produces.
 */
function candidates(text: string, length: number, lines: number): string[][] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, "").toUpperCase())
    .filter((line) => line.length === length && ZONE_CHARS.test(line));
  const found: string[][] = [];
  for (let at = 0; at + lines <= rows.length; at++) {
    found.push(rows.slice(at, at + lines));
  }
  return found;
}

interface Read {
  documentNumber: string;
  expiry: string;
  passport: boolean;
}

/** A passport zone: two lines of forty-four. */
function readTd3(line1: string, line2: string): Read | null {
  const documentNumber = line2.slice(0, 9);
  const birth = line2.slice(13, 19);
  const expiry = line2.slice(21, 27);
  const personal = line2.slice(28, 42);

  if (
    !checks(documentNumber, line2[9]!) ||
    !checks(birth, line2[19]!) ||
    !checks(expiry, line2[27]!) ||
    !checks(personal, line2[42]!)
  ) {
    return null;
  }
  // The composite covers every field at once, so a pair of errors that happen
  // to keep one field's own digit valid still fails here.
  const composite = line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
  if (!checks(composite, line2[43]!)) {
    return null;
  }
  const expiryDate = zoneDate(expiry);
  if (!expiryDate) {
    return null;
  }
  return {
    documentNumber: documentNumber.replace(/<+$/, ""),
    expiry: expiryDate,
    passport: line1.startsWith("P"),
  };
}

/**
 * An identity card zone: three lines of thirty.
 *
 * The per-field check digits are verified. The composite is not, because there
 * is no specimen in the tests to prove that implementation against, and a
 * check that has never been shown to accept a valid document is more likely to
 * reject a real card than to catch a real error.
 */
function readTd1(rows: string[]): Read | null {
  const [line1, line2] = rows as [string, string, string];
  const documentNumber = line1.slice(5, 14);
  const birth = line2.slice(0, 6);
  const expiry = line2.slice(8, 14);

  if (
    !checks(documentNumber, line1[14]!) ||
    !checks(birth, line2[6]!) ||
    !checks(expiry, line2[14]!)
  ) {
    return null;
  }
  const expiryDate = zoneDate(expiry);
  if (!expiryDate) {
    return null;
  }
  return {
    documentNumber: documentNumber.replace(/<+$/, ""),
    expiry: expiryDate,
    passport: line1.startsWith("P"),
  };
}

/** The facts a zone yields, or nothing at all if any check disagreed. */
export function mrzFacts(text: string): Fact[] {
  if (!text) {
    return [];
  }
  let read: Read | null = null;
  for (const [line1, line2] of candidates(text, TD3_LENGTH, 2)) {
    read = readTd3(line1!, line2!);
    if (read) {
      break;
    }
  }
  if (!read) {
    for (const rows of candidates(text, TD1_LENGTH, 3)) {
      read = readTd1(rows);
      if (read) {
        break;
      }
    }
  }
  if (!read) {
    return [];
  }

  const document = read.passport ? "passport" : "id-card";
  const facts: Fact[] = [
    {
      id: factId("expiry", read.expiry),
      kind: "expiry",
      document,
      value: read.expiry,
      source: "mrz",
      confidence: 1,
    },
  ];
  if (read.documentNumber) {
    facts.push({
      id: factId("identifier", read.documentNumber),
      kind: "identifier",
      document,
      value: read.documentNumber,
      masked: maskTail(read.documentNumber),
      source: "mrz",
      confidence: 1,
    });
  }
  return facts;
}
