/**
 * Reading facts out of the text this app already extracts.
 *
 * Two jobs, deliberately separate. `labelledFacts` claims a deadline only
 * where the document labelled one, which is the difference between knowing a
 * licence expires and noticing that a date appears somewhere on it.
 * `harvestFacts` picks up amounts and reference numbers from any document,
 * including kinds nobody wrote a rule for, and never promotes an unlabelled
 * date to a deadline: an unlabelled date is almost always a print date, and a
 * wrong expiry is the failure this whole design exists to avoid.
 */

import { CURRENCY_CODES, SYMBOL_CURRENCY, SYMBOL_FAMILY } from "./currency";
import { type DocumentKind, type Fact, factId, maskTail } from "./facts";
import { findDates, findTimes, parseDate, parseTime, type DateContext, type ParsedDate } from "./dates";
import { amountMeaningOf, meaningOf, type AmountMeaning, type LabelMeaning, type Lexicon } from "./lexicon";
import { LEGAL_WORDS } from "./stakes";
import { serviceOf, type Role, type Subject } from "./subject";
import { cellsOf, headerLines, tableBlocks } from "./tables";

/** How far past a label to look for its date. */
const WINDOW = 60;

/** A blank line ends a thought, so a label never reaches into the next one. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

const EXPIRY_LABELS =
  /\b(?:date\s+of\s+expiry|expir(?:es|y|ation)(?:\s+date)?|valid\s+(?:until|through|to)|renewal\s+date|good\s+through)\b/gi;
/** Cover and a lease end; a sale ends too, and is nobody's document. */
const ENDS_LABELS = /\b(?:valid\s+thru|(?:coverage|lease)\s+ends(?:\s+on)?)\b/gi;
/** EXP as licences print it: the bare upper-case token, never the start of a word or a code. */
const EXP_TOKEN = /(?<![A-Za-z0-9])EXP\.?(?![A-Za-z0-9])/g;
/**
 * The date EXP states: the one that follows it at once. A receipt prints
 * "EXP **" and "/" and then the day of the purchase, and that day is not the
 * card's.
 */
const DATE_AT_ONCE =
  /^\s*[:.]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?![/.\-\d])|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
const DUE_LABELS =
  /\b(?:payment\s+due|amount\s+due\s+by|due\s+date|due\s+on|pay\s+by)\b/gi;
/** A date to act by. The document's own words say what the act is, so they are kept as the label. */
const ACT_BY_LABELS =
  /\b(?:respond\s+by|reply\s+by|return\s+by|due\s+by|due\s+back(?:\s+(?:on|by))?|let\s+us\s+know\s+by|must\s+be\s+(?:received|paid)\s+by|will\s+be\s+(?:collected|charged|debited|taken)\s+on|deadline)\b/gi;
/** A renewal that charges: the day the money is taken. */
const RENEWS_LABELS = /\b(?:(?:auto[- ]?)?renews\s+on|renewal\s+on|next\s+(?:billing|payment)\s+date)\b/gi;
const ISSUED_LABELS = /\b(?:date\s+of\s+issue|issue\s+date|issued(?:\s+on)?)\b/gi;

/**
 * Moments rather than deadlines, which is what travel documents are made of.
 * These get the same window discipline as the deadline labels, plus a time
 * when the window carries one.
 */
const EVENT_LABELS =
  /\b(?:check[- ]?in|check[- ]?out|departure|departs|boarding(?:\s+time)?(?!\s+pass)|arrival|arrives|pick[- ]?up|drop[- ]?off)\b/gi;
/** Something that starts then. A poster prints the date first ("Sat 14 Nov, doors 7 PM"), so these also look back along their own line. */
const START_LABELS = /\b(?:appointment|doors)\b/gi;
/**
 * The start of a show, a match or a talk. When a document gives one beside
 * its doors, the start is the moment and the doors are not a second one. A
 * sale or a season that "starts" is no show, so the bare word is not read.
 */
const SHOW_LABELS =
  /\b(?:show(?:\s+starts?)?(?=\s*:|\s+\d{1,2}(?::[0-5]\d|\s?[ap]\.?m\b)|\s+at\s+\d|\s+starts?\b)|curtain(?:\s+(?:up|call)|(?=\s*:))|kick[- ]?off|(?:talk|performance|concert|event|lecture|match|game)\s+(?:starts?|begins?)|start\s+time)\b/gi;
const DOORS = /^doors\b/i;
/**
 * The words before a clock that say it only opens, closes or bounds an
 * occasion and is not one itself: "Doors: 7:00 PM", "Gates open at 1pm",
 * "Registration from 17:30", "Arrive by: 09:20", "staffed until 22:00".
 * The words for letting people in (doors, gates, registration, admission,
 * entry) say so wherever they stand before the clock; the other words only
 * as the last thing before it, so that a name which begins with one ("Open
 * mic night: 8 PM") is not taken for an opening time.
 */
const BOUNDS =
  /(?:\b(?:doors?|gates?|registration|admission|entry)\b.*|\b(?:opens?|opening|closes?|closing|until|till|by)(?:\s+(?:at|from))?)[\s:]*$/i;

/** Whether the words that stand before a clock say it only opens, closes or bounds an occasion. */
export function boundsAnOccasion(words: string): boolean {
  return BOUNDS.test(words);
}
/** Start readings that are not a show's start. */
const NOT_A_SHOW = /^(?:doors|appointment)\b/i;
/** A line that says it is a delivery, in any message. */
const DELIVERY_LABELS = /\b(?:(?:estimated|expected)\s+delivery(?:\s+date)?|delivery\s+date|delivered\s+by)\b/gi;
/** Words that mean a delivery only in a message about one: a flight arrives too. */
const ARRIVING_LABELS = /\b(?:arriving|(?:should|will)\s+arrive)\b/gi;

const sentenceCase = (words: string) => {
  const plain = words.replace(/\s+/g, " ").trim().toLowerCase();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
};

/**
 * How far a label reaches for its date. A form prints a label and its value
 * on two lines, so the labels a form uses read on below their own line.
 * The words of running text ("reply by", "arriving", "appointment") stand
 * in a sentence with their date, and what is on the next line (an order
 * day, a street called 5 June Avenue, the header of a forwarded message) is
 * another matter: those claim from their own line only.
 */
type Reach = "below" | "line" | "at-once";

/** Order matters within a kind: the first label to claim a date keeps it. */
const KINDS: { kind: Fact["kind"]; labels: RegExp; reach: Reach; label?: (words: string) => string }[] = [
  { kind: "expiry", labels: EXPIRY_LABELS, reach: "below" },
  { kind: "expiry", labels: ENDS_LABELS, reach: "line" },
  { kind: "expiry", labels: EXP_TOKEN, reach: "at-once" },
  { kind: "due", labels: DUE_LABELS, reach: "below" },
  { kind: "due", labels: ACT_BY_LABELS, reach: "line", label: sentenceCase },
  { kind: "due", labels: RENEWS_LABELS, reach: "line", label: () => "Renews" },
  { kind: "issued", labels: ISSUED_LABELS, reach: "below" },
];

/**
 * The words for a moment. A travel word keeps the document's wording and its
 * meaning is read from it; the others state their label, what the date is,
 * and for a delivery the kind of document the line makes it.
 */
const EVENTS: {
  labels: RegExp;
  reach: Exclude<Reach, "at-once">;
  label?: (words: string) => string;
  role?: Role;
  document?: DocumentKind;
  lookBack?: boolean;
  only?: DocumentKind;
  /** Its departures and arrivals may belong to a flight the line names. */
  travel?: boolean;
}[] = [
  { labels: EVENT_LABELS, reach: "below", travel: true },
  { labels: START_LABELS, reach: "line", label: sentenceCase, role: "start", lookBack: true },
  { labels: SHOW_LABELS, reach: "line", label: sentenceCase, role: "start", lookBack: true },
  { labels: DELIVERY_LABELS, reach: "line", label: () => "Delivery expected by", role: "by", document: "delivery" },
  { labels: ARRIVING_LABELS, reach: "line", label: () => "Delivery expected by", role: "by", document: "delivery", only: "delivery" },
];

/** "Book your appointment", "to schedule an appointment": an invitation, and nobody's appointment yet. */
const INVITED = /\b(?:book|schedule|make|request|arrange|need)\s+(?:an?|your|the)\s+$/i;

/**
 * Ordered, because several match the same document: an insurance certificate
 * is also a certificate, and calling it a certification would lose the rule
 * that knows what a lapsed policy means.
 */
const DOCUMENT_KINDS: { kind: DocumentKind; pattern: RegExp }[] = [
  { kind: "passport", pattern: /\bpassport\b/i },
  { kind: "drivers-license", pattern: /\bdriver'?s?\s+licen[cs]e\b|\bdriving\s+licen[cs]e\b/i },
  { kind: "residence-permit", pattern: /\bresidence\s+(?:permit|card)\b|\bwork\s+permit\b/i },
  { kind: "visa", pattern: /\bvisa\b/i },
  { kind: "id-card", pattern: /\bidentity\s+card\b|\bid\s+card\b|\bnational\s+id\b/i },
  { kind: "boarding-pass", pattern: /\bboarding\s+pass\b/i },
  { kind: "hotel-booking", pattern: /\bhotel\b[\s\S]{0,80}?\b(?:reservation|confirmation|booking)\b/i },
  { kind: "car-rental", pattern: /\bcar\s+rental\b|\brental\s+agreement\b/i },
  { kind: "itinerary", pattern: /\bflight\s+(?:confirmation|itinerary)\b|\be-?ticket\b|\bitinerary\b/i },
  { kind: "insurance", pattern: /\binsurance\b|\bpolicy\s+(?:number|holder|period)\b/i },
  { kind: "warranty", pattern: /\bwarrant(?:y|ies)\b|\bguarantee\s+period\b/i },
  { kind: "vehicle-registration", pattern: /\bvehicle\s+registration\b|\bregistration\s+certificate\b/i },
  { kind: "membership", pattern: /\bmembership\b|\bmember\s+since\b/i },
  { kind: "invoice", pattern: /\binvoice\b|\bbill\s+to\b/i },
  { kind: "delivery", pattern: /\b(?:shipped|out\s+for\s+delivery|tracking\s+number|your\s+order)\b/i },
  { kind: "certification", pattern: /\bcertificat(?:e|ion)\b|\bdiploma\b/i },
];

/** What the document appears to be, or "other" rather than a guess. */
export function guessDocumentKind(text: string): DocumentKind {
  for (const { kind, pattern } of DOCUMENT_KINDS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return "other";
}

/** The text a label is allowed to claim a date from. */
function windowAfter(text: string, from: number): string {
  const slice = text.slice(from, from + WINDOW);
  const brk = PARAGRAPH_BREAK.exec(slice);
  return brk ? slice.slice(0, brk.index) : slice;
}

/**
 * The date a label claims from its window, and the clock beside it. Its own
 * line comes first: a date further down, written another way, belongs to the
 * next label, and so does that line's clock. Only a label with no date on
 * its own line reads on, for a value printed below it or wrapped over lines.
 */
function claimed(window: string, reach: Reach, writtenAt?: number): { date: ParsedDate; time: string | null } | null {
  if (reach === "at-once") {
    const at = DATE_AT_ONCE.exec(window);
    const date = at ? parseDate(at[1]!) : null;
    return date ? { date, time: null } : null;
  }
  const [own = "", next = ""] = window.split("\n");
  const onLine = parseDate(own);
  if (onLine) {
    return { date: onLine, time: parseTime(own) };
  }
  // In a message, a month and a day with no year on the label's own line
  // are the label's date. One whose year only wrapped onto the next line
  // ("12 March" / "2029") still states its year, and that comes first.
  if (writtenAt !== undefined && !/^\s*\d{4}\b/.test(next)) {
    const undated = parseDate(own, { writtenAt });
    if (undated) {
      return { date: undated, time: parseTime(own) };
    }
  }
  if (reach === "line") {
    return null;
  }
  // A form's label reads on below itself, and only for a date that states
  // its year: a month and a day on another line could be anything.
  const below = parseDate(window);
  return below ? { date: below, time: parseTime(window) } : null;
}

/** A form's clock line is short: a label and its clock. */
const CLOCK_LINE_MAX = 40;
/** How many lines up a clock line looks for its date. */
const BLOCK_REACH = 3;

/**
 * The clock of a form's clock line ("Departs 14:20", "Check-in time: from
 * 3 PM"): a short line that is no sentence and holds a clock and no date of
 * its own. A clock inside a sentence is not one.
 */
export function clockLineTime(line: string, writtenAt?: number): string | null {
  const plain = line.trim();
  if (!plain || plain.length > CLOCK_LINE_MAX || /[.!?]$/.test(plain) || /[.!?]\s+[A-Z]/.test(plain)) {
    return null;
  }
  if (findDates(plain, writtenAt === undefined ? undefined : { writtenAt }).length > 0) {
    return null;
  }
  return parseTime(plain);
}

/**
 * The date a clock line belongs to: the nearest line above it that states
 * one, in the same block (no blank line between, at most three lines up). A
 * form prints the day once and the clocks of that day under it; the date on
 * a line below belongs to the next fact.
 */
function dateAbove(text: string, lineStart: number, writtenAt?: number, lexicon?: Lexicon): { date: ParsedDate; line: number } | null {
  let end = lineStart - 1;
  for (let step = 0; step < BLOCK_REACH && end > 0; step += 1) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    if (!line.trim()) {
      return null;
    }
    // A line that is nobody's business ("Booked on: 10 Feb 2027") lends its
    // day to nothing: the day of the fact stands further up, or nowhere.
    const field = lexicon ? FIELD_LINE.exec(line) : null;
    const nobodys = field !== null && meaningOf(lexicon!, field[1]!) === "none";
    const date = nobodys ? null : parseDate(line, writtenAt === undefined ? undefined : { writtenAt });
    if (date) {
      return { date, line: start };
    }
    end = start - 1;
  }
  return null;
}

/** Words that say only "the time of it": they name no moment of their own. */
const TIME_WORDS = new Set(["time", "date", "at", "from", "on", "the", "is", "start", "starts", "starting", "begin", "begins", "commences"]);
/** The words of a label that name what it is about. */
const namingWords = (label: string) => (label.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => !TIME_WORDS.has(word));

/**
 * The clock a form prints under a date line ("Class begins: 2 November
 * 2027", then "Class time: 6:30 PM"): a clock line below it in the same
 * block, before any other date. The clock is the moment's own when its line
 * says only "time", names what the date line names ("Class"), or is the
 * same end of a stay or a journey in the table. A clock said of something
 * else ("Arrive by: 6:15 PM", "Registration: 6:00 PM") is passed over, and
 * hours ("9:00 to 17:00") are a span and no moment.
 */
function clockBelow(text: string, line: FieldLine, meaning: LabelMeaning, lexicon: Lexicon, writtenAt?: number): string | null {
  const named = namingWords(line.label);
  let at = line.end + 1;
  for (let step = 0; step < BLOCK_REACH && at < text.length; step += 1) {
    const stop = text.indexOf("\n", at);
    const end = stop === -1 ? text.length : stop;
    const below = text.slice(at, end);
    if (!below.trim() || findDates(below, writtenAt === undefined ? undefined : { writtenAt }).length > 0) {
      return null;
    }
    const time = clockLineTime(below, writtenAt);
    const [clock, second] = findTimes(below);
    if (time && clock && !second) {
      // What the line says before its clock.
      const words = below.slice(0, clock.at);
      const said = meaningOf(lexicon, words.replace(/:\s*$/, ""));
      const own = namingWords(words);
      const sameEnd = said !== undefined && said !== "event" && said === meaning;
      if (sameEnd || ((said === undefined || said === meaning) && (own.length === 0 || own.some((word) => named.includes(word))))) {
        return time;
      }
    }
    at = end + 1;
  }
  return null;
}

/** Words that only join a label to its date: "Due date is on or before Friday 12 March", "by close of business on". */
const JOINING_WORDS = new Set(
  "is are was on by before or no not later than the date due at of for payment until till end close business day".split(" ").concat(
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split(" "),
  ),
);

/**
 * Whether other words stand between a label and the date it claimed. The
 * text after the label, up to that date, may hold joining words, a weekday,
 * a clock and a sum; any other word makes the date possibly theirs ("...by
 * the due date, interest from 22 April": the day interest starts). A date
 * that cannot be placed in the text is taken as apart.
 */
function standsApart(after: string, iso: string, writtenAt?: number): boolean {
  const found = findDates(after, writtenAt === undefined ? undefined : { writtenAt }).find((hit) => hit.date.iso === iso);
  if (!found) {
    return true;
  }
  let lead = after.slice(0, found.at);
  for (const clock of findTimes(lead).reverse()) {
    lead = `${lead.slice(0, clock.at)} ${lead.slice(clock.end)}`;
  }
  const words = lead.match(/[A-Za-z]+/g) ?? [];
  return words.some((word) => !JOINING_WORDS.has(word.toLowerCase()) && !CURRENCY_CODES.has(word.toUpperCase()));
}

/** A label whose own words say the day is due or to pay. */
const SAYS_DUE = /\b(?:dues?|pay|paid|payable|payments?|repayments?|owing|remit)\b/i;
/** A renewal's label says when a plan or a cover renews; the money may leave on another day. */
const SAYS_RENEWAL = /\brenew/i;

/**
 * Whether a label's own words say "due" or "pay". Every other label a day
 * to act by is read under (a renewal, "return by", "confirm by", "will be
 * charged on", a direct debit, a disconnection) names another matter.
 */
function saysPay(words: string): boolean {
  return SAYS_DUE.test(words) && !SAYS_RENEWAL.test(words);
}

/** Words that make a label a point of reference: the clause is about missing the day, not about the day. */
const REFERS_BACK = /\b(?:after|not|if|unless|past|following|beyond)\b/i;
/** How far back a label's own clause is read. */
const CLAUSE_REACH = 120;

/**
 * Whether a label does not state a plain day to pay because of the clause
 * it stands in: its own sentence, line and cell, read back from the label.
 * The clause may only refer to the day ("not received by the 15th day after
 * the due date (12/15/2026)", "if we have no payment by the due date"), and
 * the date that follows is then the day a fee starts. Or it names a court,
 * a hearing or a filing, where a wrong day would cost much: a label that
 * states no words of its own gives the stakes check nothing else to read.
 */
function refersBack(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - CLAUSE_REACH), at);
  const starts = Math.max(before.lastIndexOf("\n"), before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf(" | "));
  const clause = before.slice(starts + 1);
  return REFERS_BACK.test(clause) || LEGAL_WORDS.test(clause);
}

/** What may stand between a clock and the day it is said of: a comma, "on", the day's weekday. */
const CLOCK_TO_DAY = /^[\s,]*(?:on\b)?[\s,]*(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|mon|tues?|wed|thur?s?|fri|sat|sun)?[\s,.]*$/i;

/**
 * The clock of a day to act by, read from what follows its label. It is the
 * clock that stands straight after the date, with at most a joining word
 * between ("30 July 2027 17:00", "8 January at 6:00 PM"); else the one that
 * stands straight before it ("5pm, 5 February 2027", "by 11:59 PM on March
 * 3, 2027"). A clock further along the line is another matter ("open 9:00
 * to 17:00"), and so is a range of hours.
 */
function clockOfDay(line: string, writtenAt?: number): string | null {
  const [date] = findDates(line, writtenAt === undefined ? undefined : { writtenAt });
  if (!date) {
    return null;
  }
  const rest = line.slice(date.end);
  const [after] = findTimes(rest);
  if (after && /^[\s,]*(?:at|by|before|from|@)?\s*$/i.test(rest.slice(0, after.at))) {
    return after.time;
  }
  const lead = line.slice(0, date.at);
  const before = findTimes(lead).at(-1);
  return before && before.endTime === undefined && CLOCK_TO_DAY.test(lead.slice(before.end)) ? before.time : null;
}

// A flight's number as a line states it: after the word Flight ("Flight UA
// 123", "flight no. U2 45"), or two capitals and a number standing right
// before the label ("UA 123 departs"). A number followed by a colon or by
// AM or PM is a clock ("FLIGHT AT 2 PM"), and a gate (B12) is not two
// capitals.
const FLIGHT_NAMED = /\b(?:[Ff]light|FLIGHT|[Ff]lt\.?)\s*(?:[Nn]umber|[Nn]o\.?|#)?\s*([A-Z][A-Z0-9]|\d[A-Z])\s?(\d{1,4})\b(?!:)(?!\s*[AaPp]\.?[Mm]\b)/g;
const FLIGHT_BEFORE = /\b(?!AM\b|PM\b)([A-Z]{2})\s?(\d{1,4})\s+$/;
/** A line about a train, a bus or a boat names no flight, whatever code stands on it. */
const OTHER_TRAVEL = /\b(?:train|rail|bus|coach|ferry|boat)\b/i;
/** The airport a departure or an arrival names: three capitals right after the word. */
const AIRPORT_NEXT = /^\s*(?::|from|at|in|to)?\s*([A-Z]{3})\b/;

/**
 * The flight a departure or arrival label belongs to, when its own line
 * states one: the airline's code and number, and the airport right after
 * the label. Of several flights on a line, it is the last one named before
 * the label. With no flight number on the line, capitals after the label
 * are only a word, and no airport is named.
 */
function flightOn(text: string, at: number, length: number): { carrier: string; number: string; code: string; line: number } | undefined {
  const line = text.lastIndexOf("\n", at - 1) + 1;
  const stop = text.indexOf("\n", at);
  const end = stop === -1 ? text.length : stop;
  const whole = text.slice(line, end);
  if (OTHER_TRAVEL.test(whole)) {
    return undefined;
  }
  const named = [...whole.matchAll(FLIGHT_NAMED)];
  const stated = named.filter((match) => match.index < at - line).pop() ?? named[0] ?? FLIGHT_BEFORE.exec(text.slice(line, at));
  const code = AIRPORT_NEXT.exec(text.slice(at + length, end));
  if (!stated || !code) {
    return undefined;
  }
  const service = serviceOf(`${stated[1]} ${stated[2]}`);
  return service.carrier && service.number ? { carrier: service.carrier, number: service.number, code: code[1]!, line } : undefined;
}

/**
 * The same reach backwards, never past the start of the label's own line
 * and never out of its own sentence: a date before the last full stop
 * belongs to another thought ("Doors open on November 27. Book your
 * appointment" names no day for the appointment).
 */
function windowBefore(text: string, to: number): string {
  const line = text.lastIndexOf("\n", to - 1) + 1;
  const reach = text.slice(Math.max(line, to - WINDOW), to);
  const ends = [...reach.matchAll(/[.!?]\s+(?=[A-Z])/g)];
  const last = ends[ends.length - 1];
  return last ? reach.slice(last.index + last[0].length) : reach;
}

/**
 * Dates that a document labelled, which is the only kind worth trusting.
 * With the label table, a clock line on a form never takes the day of a
 * line that is nobody's business.
 */
export function labelledFacts(text: string, writtenAt?: number, lexicon?: Lexicon): Fact[] {
  // How sure a date is: one that could be read two ways, or whose year the
  // message did not print, is a question for the owner.
  const sureness = (parsed: ParsedDate) => ({
    confidence: parsed.ambiguous || parsed.assumedYear ? 0.5 : 0.7,
    ...(parsed.ambiguous ? { ambiguous: true } : {}),
    ...(parsed.assumedYear ? { assumedYear: true } : {}),
  });
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();
  // The header row of a table names its columns. It is no label for the
  // line under it: each cell there is read under its own column.
  const headers = headerLines(text);
  const inHeader = (at: number) => headers.some((header) => at >= header.at && at < header.end);
  // The days to act by whose first label says due or pay.
  const saidToPay = new Set<string>();
  for (const { kind, labels, reach, label } of KINDS) {
    labels.lastIndex = 0;
    for (let match = labels.exec(text); match; match = labels.exec(text)) {
      if (inHeader(match.index)) {
        continue;
      }
      // A document prints the year it expires in; an offer "valid thru
      // December 31" does not, and is nobody's document.
      const window = windowAfter(text, match.index + match[0].length);
      const parsed = claimed(window, reach, kind === "expiry" ? undefined : writtenAt)?.date;
      if (!parsed) {
        continue;
      }
      const id = factId(kind, parsed.iso);
      // A day to pay is stated outright where the label's own words say due
      // or pay (a rule with no label of its own is the rule for "due date"
      // and "pay by"), and the date is the label's own: the label states
      // the day and does not only refer to it, and no other words stand
      // between the label and the date.
      const says = kind === "due" && (label === undefined || saysPay(label(match[0])));
      const own = kind === "due" && !refersBack(text, match.index) && !standsApart(window, parsed.iso, writtenAt);
      const held = byId.get(id);
      if (held) {
        // The day keeps the label that read it first. Where that label says
        // due or pay but read the date loosely, a second label that says so
        // too and states the same day as its own settles it.
        if (says && own && saidToPay.has(id) && !held.toPay) {
          byId.set(id, { ...held, toPay: true });
        }
        continue;
      }
      if (says) {
        saidToPay.add(id);
      }
      const toPay = says && own;
      // A day to act by keeps the clock that stands straight after or before
      // it on the label's own line ("Return by: Fri 30 July 2027 17:00").
      const time = kind === "due" ? clockOfDay(window.split("\n", 1)[0]!, writtenAt) : null;
      byId.set(id, {
        id,
        kind,
        document,
        value: parsed.iso,
        ...(time ? { time } : {}),
        ...(label ? { label: label(match[0]) } : {}),
        ...(toPay ? { toPay: true } : {}),
        source: "label",
        // A date that could be read two ways is worth less than one that
        // could not, and the difference is what the confirmation card asks
        // about rather than something to resolve here.
        ...sureness(parsed),
      });
    }
  }
  // Each flight's departure, by its line: an arrival on the same line may
  // have only a clock.
  const departed = new Map<string, { date: ParsedDate; time: string | null }>();
  // A form prints a day once and its clocks under it. The moments read from
  // a line's own date, by that line; and the lines whose date a clock line
  // below them took.
  const madeOn = new Map<number, string[]>();
  const lent = new Set<number>();
  for (const words of EVENTS) {
    if (words.only && words.only !== document) {
      continue;
    }
    words.labels.lastIndex = 0;
    for (let match = words.labels.exec(text); match; match = words.labels.exec(text)) {
      if (inHeader(match.index) || (words.lookBack && INVITED.test(text.slice(Math.max(0, match.index - 30), match.index)))) {
        continue;
      }
      const after = windowAfter(text, match.index + match[0].length);
      const own = after.split("\n", 1)[0]!;
      const end = !words.travel ? undefined : /^depart/i.test(match[0]) ? "depart" : /^arriv/i.test(match[0]) ? "arrive" : undefined;
      const flight = end ? flightOn(text, match.index, match[0].length) : undefined;
      const flown = flight ? `${flight.line}|${flight.carrier}|${flight.number}` : "";
      let parsed: ParsedDate | null;
      let time: string | null;
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      const lineStop = text.indexOf("\n", match.index);
      // A clock line takes the day of the date line above it, and reads
      // nothing below: the date under it is the next fact's.
      const clock = flight ? null : clockLineTime(text.slice(lineStart, lineStop === -1 ? text.length : lineStop), writtenAt);
      const above = clock ? dateAbove(text, lineStart, writtenAt, lexicon) : null;
      if (clock) {
        parsed = above?.date ?? null;
        time = clock;
        if (above) {
          lent.add(above.line);
        }
      } else if (flight && end === "arrive" && !parseDate(own, writtenAt === undefined ? undefined : { writtenAt })) {
        // An arrival that names no day of its own lands on its departure's
        // day when its clock is the later one. Otherwise its day is not
        // printed (a "+1" is a hint, not a date), and the lines below are
        // another matter: nothing is stated.
        const left = departed.get(flown);
        time = parseTime(own);
        parsed = left && time && left.time && time > left.time ? left.date : null;
      } else {
        const ahead = claimed(after, words.reach, writtenAt);
        // A poster prints the date first: with none ahead, the label's own
        // line is read backwards, and the clock is whichever side has one.
        const before = !ahead && words.lookBack ? windowBefore(text, match.index) : "";
        parsed = ahead?.date ?? (before ? parseDate(before, writtenAt === undefined ? undefined : { writtenAt }) : null);
        time = ahead ? ahead.time : (parseTime(own) ?? parseTime(before));
      }
      if (!parsed) {
        continue;
      }
      // A flight is named as booking data names it, so two flights on one
      // day stay two facts and a booking and its own words agree.
      const label = flight
        ? `Flight ${flight.carrier} ${flight.number} ${end === "depart" ? "departs" : "arrives"} ${flight.code}`
        : words.label
          ? words.label(match[0])
          : match[0].trim();
      // The label joins the identity: a check-in and a check-out can share a
      // day, and a date alone would collapse them into one fact.
      const id = factId("event", `${parsed.iso} ${label.toLowerCase()}`);
      const held = byId.get(id);
      if (held) {
        // The same moment named again by its time line ("Pick-up date", then
        // "Pick-up time") gains the clock it lacked.
        if (time && !held.time) {
          byId.set(id, { ...held, time });
        }
        continue;
      }
      if (!clock) {
        madeOn.set(lineStart, [...(madeOn.get(lineStart) ?? []), id]);
      }
      if (flight && end === "depart") {
        departed.set(flown, { date: parsed, time });
      }
      const subject: Subject | undefined = flight
        ? { role: end!, mode: "flight", carrier: flight.carrier, number: flight.number, code: flight.code }
        : words.role
          ? { role: words.role }
          : undefined;
      byId.set(id, {
        id,
        kind: "event",
        document: words.document ?? document,
        value: parsed.iso,
        label,
        ...(time ? { time } : {}),
        ...(subject ? { subject } : {}),
        source: "label",
        ...sureness(parsed),
      });
    }
  }
  // A date line whose day a clock line took is the same moment, said without
  // its clock ("Arrival date", then "Check-in time"): the clock line's
  // reading is the moment, and the bare one goes.
  for (const line of lent) {
    for (const id of madeOn.get(line) ?? []) {
      if (!byId.get(id)?.time) {
        byId.delete(id);
      }
    }
  }
  // A show's start and its doors on one day are one moment: the start.
  const started = new Set(
    [...byId.values()]
      .filter((fact) => fact.kind === "event" && fact.time && fact.subject?.role === "start" && !NOT_A_SHOW.test(fact.label ?? ""))
      .map((fact) => fact.value),
  );
  for (const [id, fact] of byId) {
    if (fact.kind === "event" && fact.label && DOORS.test(fact.label) && started.has(fact.value)) {
      byId.delete(id);
    }
  }
  const asked = statedTotal(text, document, lexicon);
  if (asked) {
    byId.set(asked.id, asked);
  }
  return [...byId.values()];
}

/** How much of a line's left side can plausibly be a label. */
const MAX_LABEL_CHARS = 48;

/** A line shaped like a form field: something, a separator, a value. */
const FIELD_LINE = /^\s*([^:\n]{2,48}?)\s*:\s*(.+)$/;

/**
 * Labels that are refused outright. Birth dates on the same principle as the
 * machine-readable-zone reader: nothing here needs one and it is the most
 * sensitive date a document carries. Print and generation stamps because
 * they describe the paper, not the obligation. The Sent and Received lines
 * of a forwarded or quoted message, because they date the mail, which is
 * already known, and nothing in it.
 */
const REFUSED_LABELS = /\b(birth|born|dob\b|print|generat|creat|download|scan)|^(?:sent|received)$/i;
/** A line of a message's header, as a forward or a quoted reply prints it. */
const MAIL_HEADER = /^\s*(?:from|to|cc|bcc|subject|date|sent|received|reply-to)\s*:/i;

/**
 * Every labelled date in the document, with the label attached verbatim.
 *
 * The vocabulary above can never be finished: one benefits form says "Valid Till", a
 * gym contract says something else, a Korean tax form says it in Korean.
 * What generalizes is the structure, a label beside a date, plus the owner
 * reading their own document's words. The card quotes the label; the human
 * supplies the meaning once. Values the vocabulary already claimed are
 * skipped, so a known label is typed and an unknown one still surfaces.
 */
export function structuralDatedFacts(
  text: string,
  claimed: ReadonlySet<string>,
  opts: { lexicon?: Lexicon; writtenAt?: number } = {},
): Fact[] {
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();
  const lines = fieldLines(text).map((line) => ({ ...line, meaning: opts.lexicon ? meaningOf(opts.lexicon, line.label) : undefined }));
  // One date, one reading: a day a typed label read is not read again from
  // a line that only names it.
  const read = new Set(claimed);

  // The lines whose label the table knows. A label that means nothing for
  // the reader ("Statement date") gives nothing; every other meaning is a
  // reading like a word rule's, under the document's own words.
  for (const line of lines) {
    const meaning = line.meaning;
    if (meaning === undefined || meaning === "none") {
      continue;
    }
    // A document prints the year it expires in, and a day of issue is
    // behind the message, not ahead of it: neither takes a guessed year.
    const context = meaning === "expiry" || meaning === "issued" || opts.writtenAt === undefined ? undefined : { writtenAt: opts.writtenAt };
    const parsed = parseDate(line.value.slice(0, WINDOW), context);
    // In a table, two moments can share a day, each under its own column
    // ("Departs" and "Arrives"): both stand, unless a word rule read that day.
    const second = parsed !== null && line.column === true && MOMENTS.has(meaning) && !claimed.has(parsed.iso);
    if (!parsed || (read.has(parsed.iso) && !second)) {
      continue;
    }
    const label = line.label.slice(0, MAX_LABEL_CHARS);
    const sure = {
      confidence: parsed.ambiguous || parsed.assumedYear ? 0.5 : 0.7,
      ...(parsed.ambiguous ? { ambiguous: true as const } : {}),
      ...(parsed.assumedYear ? { assumedYear: true as const } : {}),
    };
    if (meaning === "due" || meaning === "expiry" || meaning === "issued") {
      const id = factId(meaning, parsed.iso);
      if (!byId.has(id)) {
        const time = meaning === "due" ? clockOfDay(line.value, opts.writtenAt) : null;
        const toPay = meaning === "due" && saysPay(label) && !standsApart(line.value.slice(0, WINDOW), parsed.iso, opts.writtenAt);
        byId.set(id, {
          id,
          kind: meaning,
          document,
          value: parsed.iso,
          ...(time ? { time } : {}),
          label,
          ...(toPay ? { toPay: true } : {}),
          source: "label",
          ...sure,
        });
      }
    } else {
      const id = factId("event", `${parsed.iso} ${label.toLowerCase()}`);
      if (!byId.has(id)) {
        // The clock on the line itself, or on the clock line a form prints
        // under it. A cell among others has no line under it of its own.
        const time = parseTime(line.value) ?? (line.part ? null : clockBelow(text, line, meaning, opts.lexicon!, opts.writtenAt));
        byId.set(id, {
          id,
          kind: "event",
          document,
          value: parsed.iso,
          label,
          ...(time ? { time } : {}),
          ...(meaning === "event" ? {} : { subject: { role: meaning } }),
          source: "label",
          ...sure,
        });
      }
    }
    read.add(parsed.iso);
  }

  // A row of a table is one moment: its day stands in one cell and its
  // clocks in others, each under the header that says what it is
  // ("Date | Departs | Arrives"). A day and one clock in a row are one
  // moment whatever their columns are called ("Date | Time | Room").
  if (opts.lexicon && ROW_MARK.test(text)) {
    const context = opts.writtenAt === undefined ? undefined : { writtenAt: opts.writtenAt };
    for (const block of tableBlocks(text)) {
      for (const row of block.header ? block.rows : []) {
        if (row.length < block.header!.length) {
          continue;
        }
        const days: { parsed: ParsedDate; label: string; meaning: LabelMeaning | undefined }[] = [];
        const clocks: { time: string; label: string; meaning: LabelMeaning | undefined }[] = [];
        for (const [column, cell] of row.entries()) {
          const label = block.header![column]?.text.replace(/\s+/g, " ") ?? "";
          const meaning = label ? meaningOf(opts.lexicon, label) : undefined;
          const parsed = /\d/.test(cell.text) ? parseDate(cell.text.slice(0, WINDOW), context) : null;
          const time = parsed || !CLOCK_CELL.test(cell.text) ? null : clockLineTime(cell.text, opts.writtenAt);
          if (parsed) {
            days.push({ parsed, label, meaning });
          } else if (time) {
            clocks.push({ time, label, meaning });
          }
        }
        const [day] = days;
        const [clock] = clocks;
        if (days.length !== 1 || !day || !clock || day.meaning === "none") {
          continue;
        }
        const iso = day.parsed.iso;
        const moment = (time: string, words: string, role?: LabelMeaning) => {
          const label = words.slice(0, MAX_LABEL_CHARS);
          const plain = factId("event", `${iso} ${label.toLowerCase()}`);
          // Two rows of one day under one header are two moments.
          const id = byId.has(plain) && byId.get(plain)!.time !== time ? factId("event", `${iso} ${time} ${label.toLowerCase()}`) : plain;
          if (!byId.has(id)) {
            byId.set(id, {
              id,
              kind: "event",
              document,
              value: iso,
              label,
              time,
              ...(role && role !== "event" ? { subject: { role: role as Role } } : {}),
              source: "label",
              confidence: day.parsed.ambiguous || day.parsed.assumedYear ? 0.5 : 0.7,
              ...(day.parsed.ambiguous ? { ambiguous: true as const } : {}),
              ...(day.parsed.assumedYear ? { assumedYear: true as const } : {}),
            });
          }
          read.add(iso);
        };
        const named = clocks.filter((one) => one.meaning !== undefined && MOMENTS.has(one.meaning));
        if (named.length > 0) {
          for (const one of named) {
            moment(one.time, one.label, one.meaning);
          }
        } else if (clocks.length === 1 && clock.meaning === undefined) {
          const held = [...byId.values()].find((fact) => fact.value === iso && fact.source === "label" && fact.label === day.label.slice(0, MAX_LABEL_CHARS));
          if (held) {
            // The day was read under its own header: the row's clock is that moment's.
            if (!held.time) {
              byId.set(held.id, { ...held, time: clock.time });
            }
          } else if (
            day.meaning === undefined &&
            DAY_COLUMN.test(day.label) &&
            CLOCK_COLUMN.test(clock.label) &&
            !row.some((cell) => HOLDS_MONEY.test(cell.text))
          ) {
            // A timetable: its columns say "Date" and "Time". A row that
            // holds an amount is a payment with its time of day, no moment.
            moment(clock.time, clock.label || day.label);
          }
        }
      }
    }
  }

  // The lines whose label the table does not hold: kept with their own
  // words, as before, and only for a date that states its year. A cell
  // under a column's header is no such line: a list of payments under
  // "Date" names nothing.
  for (const line of lines) {
    if (line.meaning !== undefined || line.column) {
      continue;
    }
    const parsed = parseDate(line.value.slice(0, WINDOW));
    if (!parsed || read.has(parsed.iso)) {
      continue;
    }
    const id = factId("dated", parsed.iso);
    if (byId.has(id)) {
      continue;
    }
    byId.set(id, {
      id,
      kind: "dated",
      document,
      value: parsed.iso,
      label: line.label.slice(0, MAX_LABEL_CHARS),
      source: "label",
      // Below a typed label, above bare harvesting: the anchor is real but
      // its meaning is the owner's to supply.
      confidence: 0.4,
      ...(parsed.ambiguous ? { ambiguous: true } : {}),
    });
  }
  return [...byId.values()];
}

/** One line shaped like a form field, with its place in the text. */
export interface FieldLine {
  at: number;
  end: number;
  label: string;
  value: string;
  /** The label is the header of the value's column: the value is one cell of a table. */
  column?: true;
  /** Other cells stand on the same line: the field does not run to the line's end. */
  part?: true;
}

/** What a line holds when it may be a row of cells: a bar, a tab or a wide gap. */
const ROW_MARK = /\||\t| {3}/;
/** The meanings that are a moment: something happens on that day, at that clock. */
const MOMENTS: ReadonlySet<LabelMeaning> = new Set<LabelMeaning>(["event", "check-in", "check-out", "depart", "arrive"]);
/** The columns of a timetable that names no kind of moment: a day and a clock, called so. */
const DAY_COLUMN = /^(?:date|day|when)$/i;
const CLOCK_COLUMN = /^(?:time|start|starts|start time|begins|from|at)$/i;
/** A cell that holds a sum of money: a currency sign, or two decimals. */
const HOLDS_MONEY = /[$£€₹¥]\s?\d|\d[.,]\d{2}(?!\d)/;
/** A clock as a cell of a table states it: with a colon, or with AM or PM. "10.45" under an amount is no clock. */
const CLOCK_CELL = /\d:\d\d|\d\s?[ap]\.?m\b|\bnoon\b|\bmidnight\b/i;

/** A label, a colon, a value, in a line or in one cell; null for a clock's colon and for a refused label. */
function asField(words: string): { label: string; value: string } | null {
  const field = FIELD_LINE.exec(words);
  const colon = words.indexOf(":");
  if (!field || (/\d/.test(words[colon - 1] ?? "") && /\d/.test(words[colon + 1] ?? ""))) {
    return null;
  }
  const label = field[1]!.replace(/\s+/g, " ").trim();
  return /[A-Za-z]/.test(label) && !REFUSED_LABELS.test(label) ? { label, value: field[2]!.trim() } : null;
}

/** Whether a cell's words can name the cell beside or under them: short, with a letter, and no value themselves. */
function namesACell(words: string): boolean {
  return /[A-Za-z]/.test(words) && words.length <= MAX_LABEL_CHARS && !REFUSED_LABELS.test(words) && !(/\d/.test(words) && (findDates(words).length > 0 || findTimes(words).length > 0));
}

/**
 * The form lines of a text: a label, a colon, a value. Left out: a line
 * whose colon is a clock's ("from 15:00 on 8 April" is a sentence, not a
 * label), a refused label, and the header lines of a forwarded or quoted
 * message, which date the mail and nothing in it. A Date line counts as a
 * header only beside another header line: a ticket prints "Date:" too.
 *
 * A table gives form lines too. Under a header row, each cell is a field
 * named by the header of its column. With no header, a row of two cells is
 * a label and its value, and a cell that is itself "Label: value" is a
 * field of its own (a page set in two columns). A line of cells is never
 * read whole.
 */
export function fieldLines(text: string): FieldLine[] {
  const spans: { at: number; end: number; line: string }[] = [];
  for (let at = 0; at <= text.length; ) {
    const stop = text.indexOf("\n", at);
    const end = stop === -1 ? text.length : stop;
    const line = text.slice(at, end).replace(/\r$/, "");
    spans.push({ at, end: at + line.length, line });
    at = end + 1;
  }
  const header = spans.map(({ line }) => MAIL_HEADER.test(line));
  const headed = ROW_MARK.test(text) ? tableBlocks(text).filter((block) => block.header !== undefined) : [];
  const fields: FieldLine[] = [];
  for (const [index, { at, end, line }] of spans.entries()) {
    const cells = ROW_MARK.test(line) ? cellsOf(line, at).filter((cell) => cell.text !== "") : [];
    if (cells.length >= 2) {
      if (headed.some((block) => at >= block.at && at < block.end)) {
        // A header row, or a row under one: read by its columns, below.
        continue;
      }
      const own = cells.flatMap((cell) => {
        const field = asField(cell.text);
        return field ? [{ at: cell.at, end: cell.end, ...field, part: true as const }] : [];
      });
      fields.push(...own);
      const [first, second] = cells as [(typeof cells)[number], (typeof cells)[number]];
      if (own.length === 0 && cells.length === 2 && namesACell(first.text)) {
        fields.push({ at: first.at, end: second.end, label: first.text.replace(/\s+/g, " "), value: second.text });
      }
      continue;
    }
    const field = asField(line);
    if (!field || (header[index] && (header[index - 1] || header[index + 1]))) {
      continue;
    }
    fields.push({ at: at + (line.length - line.trimStart().length), end, ...field });
  }
  for (const block of headed) {
    for (const row of block.rows) {
      if (row.length < block.header!.length) {
        // A cell is missing and the rest cannot be placed under the header.
        continue;
      }
      for (const [column, cell] of row.entries()) {
        const label = block.header![column]?.text.replace(/\s+/g, " ") ?? "";
        if (cell.text !== "" && namesACell(label)) {
          fields.push({ at: cell.at, end: cell.end, label, value: cell.text, column: true, part: true });
        }
      }
    }
  }
  return fields.sort((a, b) => a.at - b.at);
}

/**
 * The places whose date the table says is nobody's business: each such
 * line, from its label to the end of the date the label names. Nothing is
 * read there, and nothing else should ask about that date. What stands
 * further along the line ("..., please pay before 20 Feb 2027", or a second
 * column the text extraction joined on) is not the label's, and stays open.
 */
export function settledNowhere(text: string, lexicon: Lexicon, context?: DateContext): { at: number; end: number }[] {
  const spans: { at: number; end: number }[] = [];
  for (const line of fieldLines(text)) {
    if (meaningOf(lexicon, line.label) !== "none") {
      continue;
    }
    const [own] = findDates(line.value, context);
    if (own) {
      // The value runs to the end of its line.
      spans.push({ at: line.at, end: line.end - line.value.length + own.end });
    }
  }
  return spans;
}

// The two forms the harvest reads. Two decimals and no digit after them.
const SYMBOL_AMOUNT = /([$£€₹¥])\s?([\d,]+\.\d{2})(?!\d)/g;
const CODE_AMOUNT = /\b([A-Z]{3})\s?([\d,]+\.\d{2})\b/g;

/**
 * A number shaped like money: two decimals behind a full stop ("1,250.50"),
 * or behind a decimal comma with full stops between the thousands
 * ("1.250,00"), as much of Europe writes it. Two decimals are required, so
 * "1,250" (thousands, or a decimal comma cut short) is no amount, and
 * neither is the "1.25" inside "1.250,00".
 */
const MONEY_NUMBER = /(?<![\d.,])(?:(\d{1,3}(?:\.\d{3})*,\d{2})(?![\d,.]*\d)|(\d[\d,]*\.\d{2})(?!\d))/g;
/** A hyphen, or the minus sign some statements print. */
const MINUS = `[-${String.fromCharCode(0x2212)}]`;
/** A minus sign on an amount: nothing but a space or a mark before it ("10.00-20.00" is a range). */
const SIGN = `(?:(?<![\\dA-Za-z])(${MINUS}))?`;
/** A currency straight before a number, with its minus sign before or behind it ("-£5.50", "CAD -20.00"). */
const SYMBOL_BEFORE = new RegExp(`${SIGN}([$£€₹¥])\\s?(${MINUS})?$`);
const CODE_BEFORE = new RegExp(`${SIGN}(?<![A-Za-z0-9_])([A-Z]{3})\\s?(${MINUS})?$`);
/** A minus sign straight before a number whose currency stands behind it ("-20,00 €"). */
const SIGN_BEFORE = new RegExp(`(?<![\\dA-Za-z])${MINUS}$`);
/**
 * A currency straight behind a number, on the same line. A symbol glued to
 * the number after it is that number's ("2.50 £40.00"), not this one's.
 */
const UNIT_AFTER = new RegExp(`^[ \\t]?(?:([$£€₹¥])(?!${MINUS}?\\d)|([A-Z]{3})(?![A-Za-z0-9_]))`);
/** How far before a number its currency and sign can reach. */
const UNIT_REACH = 12;
const plain = (written: string) => written.replace(/,/g, "");
const fromComma = (written: string) => written.replace(/\./g, "").replace(",", ".");

/** An amount where a text states it: from its currency (or its sign) to its last character. */
export interface Money {
  value: string;
  unit: string;
  at: number;
  end: number;
  /** A minus sign stands on it: an adjustment, never a sum. */
  minus?: true;
}

/**
 * Every place a piece of text states an amount above zero with its
 * currency, in the order they stand. The currency is a symbol or a code,
 * straight before the number or straight behind it. Each number has one
 * currency and each currency belongs to one number: a code between two
 * numbers is the first one's when that number has no other.
 */
export function moneyEvery(text: string): Money[] {
  const found: Money[] = [];
  // Where the last currency taken from behind a number ends.
  let taken = 0;
  for (const match of text.matchAll(MONEY_NUMBER)) {
    const start = match.index;
    const stop = start + match[0].length;
    const value = match[1] !== undefined ? fromComma(match[1]) : plain(match[2]!);
    const before = text.slice(Math.max(0, start - UNIT_REACH), start);
    const offset = start - before.length;
    const symbol = SYMBOL_BEFORE.exec(before);
    const lead = symbol ?? CODE_BEFORE.exec(before);
    const leadUnit = symbol ? SYMBOL_CURRENCY[symbol[2]!] : lead && CURRENCY_CODES.has(lead[2]!) ? lead[2]! : undefined;
    const after = UNIT_AFTER.exec(text.slice(stop, stop + 5));
    const behind = after?.[1] ? SYMBOL_CURRENCY[after[1]] : after?.[2] && CURRENCY_CODES.has(after[2]) ? after[2] : undefined;
    let amount: Money | undefined;
    if (lead && leadUnit && offset + lead.index + (lead[1] ? 1 : 0) >= taken) {
      amount = { value, unit: leadUnit, at: offset + lead.index, end: stop, ...(lead[1] || lead[3] ? { minus: true as const } : {}) };
      // "$35.00 CAD": the code says which dollar, and is not the next number's.
      if (symbol && after?.[2] && SYMBOL_FAMILY[symbol[2]!]?.includes(after[2])) {
        amount = { ...amount, unit: after[2], end: stop + after[0].length };
        taken = amount.end;
      }
    } else if (after && behind && !/[A-Za-z]/.test(text[start - 1] ?? "")) {
      const signed = SIGN_BEFORE.test(before);
      amount = { value, unit: behind, at: signed ? start - 1 : start, end: stop + after[0].length, ...(signed ? { minus: true as const } : {}) };
      taken = amount.end;
    }
    if (amount && Number(value) > 0) {
      found.push(amount);
    }
  }
  return found;
}

/** Words that mark the amount a document is about, before its line items. */
export const SUM_LINE = /\b(?:total|due|balance|paid|charged|refund(?:ed)?|fare|price|premium)\b/i;
/** What one of something costs, as the words after or before an amount say it ("per night", "a month", "/mo"). */
const RATE_UNIT = "(?:night|month|week|day|hour|session|visit|class|lesson|seat|piece|person|guest|item|unit|mo)";
/** The price of one of something, said straight after the amount ("$140.00 per night"). A year's price is the year's whole price. */
const RATE_AFTER = new RegExp(`^\\s*(?:(?:per|a|an|each|every)\\s+|/\\s?)${RATE_UNIT}\\b`, "i");
/** The same, said by the label before it ("Room rate per night USD 150.00"). */
const RATE_BEFORE = new RegExp(`\\b(?:per|each|every)\\s+${RATE_UNIT}$`, "i");
/** Money set aside against a later bill, named straight before the amount ("a deposit of $100.00"). */
const DEPOSIT_BEFORE = /\bdeposit(?:\s+(?:of|paid))?\s*:?\s*$/i;
/** A count straight before the amount: the price of one of several ("2 x $55.00"). */
const COUNT_BEFORE = /\b\d+\s?[x×]\s*$/i;
/** What closes a label before its amount: a colon, leader dots, a dash, a bar. */
const LABEL_CLOSE = /[\s:.=|;,-]+$/;
/** What parts one label from the one before it on a line. */
const LABEL_BREAK = /[,;|\t]|\s{2,}/g;

/** An amount with the words that name it, and what the label table says those words mean. */
export interface AmountLine extends Money {
  /** The document's own words for the amount: before it on its line, or on the line above an amount that stands alone. */
  label?: string;
  /** What the amount is, where its own marks or the table say so; a part is never the whole. */
  meaning?: AmountMeaning;
}

/** Words as a label: without the break that opens them, short, and with a letter. */
function asLabel(words: string): string | undefined {
  const label = words.replace(/^[\s,;|]+/, "").trim();
  return label.length <= MAX_LABEL_CHARS && /[A-Za-z]/.test(label) ? label : undefined;
}

/**
 * The words that close a stretch of text, as a label: without what closes
 * them, and from the last break on. A comma is always a break: the words
 * before it are another thing ("3 items, total"), and joined to the label
 * they would name something else.
 */
function closingLabel(words: string): string | undefined {
  const closed = words.replace(LABEL_CLOSE, "");
  let from = 0;
  for (const cut of closed.matchAll(LABEL_BREAK)) {
    from = cut.index + cut[0].length;
  }
  return asLabel(closed.slice(from));
}

/**
 * Every amount a text states, each with its label and what the label means.
 *
 * The label is the words before the amount on its line, back to the amount
 * or the break before them; an amount alone on its line takes the line
 * above, as a table read out cell by cell prints it. A minus sign, a rate
 * ("per night"), a deposit and the price of one of several ("2 x") make a
 * part, whatever the words say. Otherwise the table decides, and words it
 * does not hold decide nothing.
 */
export function amountLines(text: string, lexicon?: Lexicon): AmountLine[] {
  const stated = moneyEvery(text);
  const { cells, currencies } = rowCells(text);
  // The one currency a document names, in its tables' headers and on its amounts.
  const named = new Set([...currencies, ...stated.map((amount) => amount.unit)]);
  const only = named.size === 1 ? [...named][0] : undefined;
  // A number alone in a cell is an amount too: under a column that names
  // its currency, or beside a name the label table knows ("Amount due")
  // in a document that names one currency.
  const alone = cells.flatMap((cell): Money[] => {
    const unit = cell.unit ?? (only && lexicon && cell.first && amountMeaningOf(lexicon, cell.first) !== undefined ? only : undefined);
    const number = unit ? AMOUNT_ALONE.exec(cell.text) : null;
    if (!unit || !number || stated.some((amount) => amount.at >= cell.at && amount.at < cell.end)) {
      return [];
    }
    const value = number[2] !== undefined ? fromComma(number[2]) : plain(number[3]!);
    return Number(value) > 0 ? [{ value, unit, at: cell.at, end: cell.end, ...(number[1] ? { minus: true as const } : {}) }] : [];
  });
  const found = alone.length > 0 ? [...stated, ...alone].sort((a, b) => a.at - b.at) : stated;
  let next = 0;
  return found.map((amount, index) => {
    const lineStart = text.lastIndexOf("\n", amount.at - 1) + 1;
    const stop = text.indexOf("\n", amount.end);
    const lineEnd = stop === -1 ? text.length : stop;
    const lineBefore = text.slice(lineStart, amount.at);
    const earlier = found[index - 1];
    const own = closingLabel(text.slice(Math.max(lineStart, earlier ? earlier.end : 0), amount.at));
    let label = own;
    if (!label && lineStart > 0 && !lineBefore.trim() && !text.slice(amount.end, lineEnd).trim()) {
      const aboveStart = text.lastIndexOf("\n", lineStart - 2) + 1;
      if (!found.some((other) => other.at >= aboveStart && other.at < lineStart)) {
        label = closingLabel(text.slice(aboveStart, lineStart - 1));
      }
    }
    // In a row of a table an amount has more names than the words before
    // it: the words in its own cell, the name its row starts with, and the
    // header of its column. The first of them that the table of labels
    // knows says what the amount is ("Subtotal" under a column "Total" is
    // a part); with none known, the nearest name is its label.
    while (next < cells.length && cells[next]!.end <= amount.at) {
      next += 1;
    }
    const cell = cells[next] && cells[next]!.at <= amount.at ? cells[next] : undefined;
    let known: AmountMeaning | undefined;
    if (cell) {
      const inCell = closingLabel(text.slice(Math.max(cell.at, earlier ? earlier.end : 0), amount.at));
      const names = [inCell, cell.first, inCell ? undefined : own, cell.header].filter((name): name is string => name !== undefined);
      const typed = lexicon ? names.find((name) => amountMeaningOf(lexicon, name) !== undefined) : undefined;
      label = typed ?? names[0] ?? label;
      known = typed && lexicon ? amountMeaningOf(lexicon, typed) : undefined;
    }
    const deposit = DEPOSIT_BEFORE.exec(lineBefore);
    const part =
      amount.minus ||
      RATE_AFTER.test(text.slice(amount.end, amount.end + 16)) ||
      (own !== undefined && RATE_BEFORE.test(own)) ||
      COUNT_BEFORE.test(lineBefore) ||
      // "Total due after your deposit: $353.60" names the total, not the
      // deposit: only what stands before the word says so.
      (deposit !== null && !SUM_LINE.test(lineBefore.slice(0, deposit.index)));
    const meaning = part ? "part" : cell ? known : label && lexicon ? amountMeaningOf(lexicon, label) : undefined;
    return { ...amount, ...(label ? { label } : {}), ...(meaning ? { meaning } : {}) };
  });
}

/** A number shaped like money, alone in a cell, with the minus sign it may carry. */
const AMOUNT_ALONE = new RegExp(`^(${MINUS})?\\s?(?:(\\d{1,3}(?:\\.\\d{3})*,\\d{2})|(\\d[\\d,]*\\.\\d{2}))$`);

/** The currency a cell of names states: a code or a symbol ("Amount (GBP)", "Price in EUR", "Total £"). */
function currencyNamed(words: string): string | undefined {
  if (/\d/.test(words)) {
    return undefined;
  }
  for (const code of words.matchAll(/\b[A-Z]{3}\b/g)) {
    if (CURRENCY_CODES.has(code[0])) {
      return code[0];
    }
  }
  const symbol = /[$£€₹¥]/.exec(words);
  return symbol ? SYMBOL_CURRENCY[symbol[0]] : undefined;
}

/** A cell of a table's row, with the names that stand for it. */
interface RowCell {
  at: number;
  end: number;
  text: string;
  /** The name the row starts with, when this is not that cell. */
  first?: string;
  /** The header of the cell's column. */
  header?: string;
  /** The currency the column names: in its header, or in the first row of a table with none. */
  unit?: string;
}

/** Every cell of every table row of a text, in the order they stand, and the currencies the tables name. */
function rowCells(text: string): { cells: RowCell[]; currencies: string[] } {
  const cells: RowCell[] = [];
  const currencies: string[] = [];
  for (const block of ROW_MARK.test(text) ? tableBlocks(text) : []) {
    const names = block.header ?? block.rows[0]!;
    const units = names.map((name) => currencyNamed(name.text));
    const named = [...new Set(units.filter((unit): unit is string => unit !== undefined))];
    currencies.push(...named);
    // Under a header, a number takes the currency of its own column only: a
    // rate or a count beside the amounts is no amount. With no header, the
    // one currency the first row names stands for the block.
    const shared = !block.header && named.length === 1 ? named[0] : undefined;
    for (const row of block.rows) {
      const first = row[0] && namesACell(row[0].text) ? row[0].text : undefined;
      for (const [column, cell] of row.entries()) {
        if (cell.text === "") {
          continue;
        }
        // A row shorter than the header could not be placed under it.
        const placed = !block.header || row.length >= block.header.length;
        const header = placed ? block.header?.[column]?.text : undefined;
        // A sum that stands alone after its row's name, in a table of two
        // currencies: which column it belongs to is not known.
        const adrift = named.length > 1 && column > 1 && row.slice(1, column).every((between) => between.text === "");
        const unit = adrift || !placed ? undefined : (units[column] ?? shared);
        cells.push({ at: cell.at, end: cell.end, text: cell.text, ...(column > 0 && first ? { first } : {}), ...(header ? { header } : {}), ...(unit ? { unit } : {}) });
      }
    }
  }
  return { cells, currencies };
}

const AMOUNT_DUE_LINE = /\b(?:(?:amount|total|balance)\s+due|amount\s+payable|(?:is|are)\s+due)\b/i;
/** Words of a payslip or of a bank account's statement, whose totals are no bill's. */
const NOT_A_BILL = /\b(?:pay\s?slip|pay\s?stub|net pay|gross pay|take[- ]home pay|opening balance|closing balance|paid in|paid out|money in|money out|withdrawals?)\b/i;
/** A statement's minimum is due as well as its balance: two answers to one question. */
const MINIMUM = /\bmin(?:imum\b|\.|\b)/i;

/**
 * The whole amount a document states: what is still due, or else what it
 * came to.
 *
 * An amount is due where its line says so ("Amount due $84.20", "Rent of
 * USD 2,400.00 is due") or where the label table says its label means that
 * ("Total to pay", "Patient balance"). With nothing due, the amount whose
 * label means the total is it ("Total paid", "Order total"). A part is
 * never either. Two different amounts due, or two different totals, are not
 * guessed between; a line that says an amount is due and holds two that
 * could be it, or a minimum anywhere beside a balance, names no single
 * amount, and then none is stated. Nothing due (0.00) is not an amount due.
 */
function statedTotal(text: string, document: DocumentKind, lexicon?: Lexicon): Fact | undefined {
  const amounts = amountLines(text, lexicon);
  // Each value once, under the first name the document gives it.
  const due = new Map<string, { unit: string; label: string }>();
  const total = new Map<string, { unit: string; label: string }>();
  const keep = (into: Map<string, { unit: string; label: string }>, amount: AmountLine, label: string) => {
    if (!into.has(amount.value)) {
      into.set(amount.value, { unit: amount.unit, label });
    }
  };
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    const here = amounts.filter((amount) => amount.at >= lineStart && amount.at < lineEnd);
    // A minimum on the amount's own line, or in the label a line above it.
    if (here.length > 0 && (MINIMUM.test(line) || here.some((amount) => MINIMUM.test(amount.label ?? "")))) {
      return undefined;
    }
    // What the line could be saying is due: each value once, and never a part.
    const open = [...new Map(here.filter((amount) => amount.meaning !== "part").map((amount) => [amount.value, amount])).values()];
    const says = AMOUNT_DUE_LINE.exec(line);
    // A line that only says something is due names no amount, and is not a
    // second answer.
    if (says && open.length > 0) {
      if (open.length > 1) {
        return undefined;
      }
      const [one] = open as [AmountLine];
      // "Rent of USD 2,400.00 is due": the amount stands before the words. A
      // prize named after them ("Your feedback is due! Win $50.00") is not it.
      if (!(/^(?:is|are)\s/i.test(says[0]) && one.at - lineStart > says.index)) {
        keep(due, one, one.meaning === "due" && one.label ? one.label : "Amount due");
      }
    }
    for (const amount of here) {
      if (amount.label && amount.meaning === "due") {
        keep(due, amount, amount.label);
      } else if (amount.label && amount.meaning === "total") {
        keep(total, amount, amount.label);
      }
    }
    lineStart = lineEnd + 1;
  }
  // A payslip's total, or a bank account's, is what was earned or moved:
  // only an amount that is due is such a document's to state.
  const stated = due.size > 0 ? due : NOT_A_BILL.test(text) ? new Map<string, { unit: string; label: string }>() : total;
  if (stated.size !== 1) {
    return undefined;
  }
  const [[value, named]] = [...stated] as [[string, { unit: string; label: string }]];
  return {
    id: factId("amount", value),
    kind: "amount",
    document,
    value,
    unit: named.unit,
    label: named.label,
    sum: due.size > 0 ? "due" : "total",
    source: "label",
    confidence: 0.7,
  };
}
const TOKEN = /\b[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;
// A date and a clock joined by T, as invites and mail headers write them
// (20261201T140000Z, or the 2027-03-04T10 a colon cuts a longer one to):
// letters and digits together, and never a reference number.
const TIMESTAMP = /^(?:\d{8}T\d{4,6}|\d{4}-\d{2}-\d{2}T\d{2}(?:-?\d{2}){0,2})(?:Z|-\d{4})?$/;

/** The weakest signal: enough to be worth offering, never enough to act on. */
const HARVEST_CONFIDENCE = 0.3;

/**
 * Amounts and reference numbers from any document, including kinds no rule
 * anticipated. Never emits a date: see the note at the top of this file.
 */
export function harvestFacts(text: string): Fact[] {
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();

  const addAmount = (raw: string, unit: string) => {
    const value = raw.replace(/,/g, "");
    const id = factId("amount", value);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        kind: "amount",
        document,
        value,
        unit,
        source: "pattern",
        confidence: HARVEST_CONFIDENCE,
      });
    }
  };

  SYMBOL_AMOUNT.lastIndex = 0;
  for (let m = SYMBOL_AMOUNT.exec(text); m; m = SYMBOL_AMOUNT.exec(text)) {
    addAmount(m[2]!, SYMBOL_CURRENCY[m[1]!] ?? m[1]!);
  }
  CODE_AMOUNT.lastIndex = 0;
  for (let m = CODE_AMOUNT.exec(text); m; m = CODE_AMOUNT.exec(text)) {
    if (CURRENCY_CODES.has(m[1]!)) {
      addAmount(m[2]!, m[1]!);
    }
  }

  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const token = m[0];
    // Both letters and digits: a word is not a reference number, and neither
    // is a bare run of digits, which is far more often a date or an amount.
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token) || TIMESTAMP.test(token)) {
      continue;
    }
    const id = factId("identifier", token);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        kind: "identifier",
        document,
        value: token,
        masked: maskTail(token),
        source: "pattern",
        confidence: HARVEST_CONFIDENCE,
      });
    }
  }

  return [...byId.values()];
}
