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

import { type DocumentKind, type Fact, factId, maskTail } from "./facts";
import { parseDate, parseTime, type ParsedDate } from "./dates";
import { serviceOf, type Role, type Subject } from "./subject";

/** How far past a label to look for its date. */
const WINDOW = 60;

/** A blank line ends a thought, so a label never reaches into the next one. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

const EXPIRY_LABELS =
  /\b(?:date\s+of\s+expiry|expir(?:es|y|ation)(?:\s+date)?|valid\s+(?:until|through|thru|to)|renewal\s+date|good\s+through|coverage\s+ends|ends\s+on)\b/gi;
/** EXP as licences print it: the bare upper-case token, never the start of a word or a code. */
const EXP_TOKEN = /(?<![A-Za-z0-9])EXP\.?(?![A-Za-z0-9])/g;
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
/** A line that says it is a delivery, in any message. */
const DELIVERY_LABELS = /\b(?:(?:estimated|expected)\s+delivery(?:\s+date)?|delivery\s+date|delivered\s+by)\b/gi;
/** Words that mean a delivery only in a message about one: a flight arrives too. */
const ARRIVING_LABELS = /\b(?:arriving|(?:should|will)\s+arrive)\b/gi;

const sentenceCase = (words: string) => {
  const plain = words.replace(/\s+/g, " ").trim().toLowerCase();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
};

/** Order matters within a kind: the first label to claim a date keeps it. */
const KINDS: { kind: Fact["kind"]; labels: RegExp; label?: (words: string) => string }[] = [
  { kind: "expiry", labels: EXPIRY_LABELS },
  { kind: "expiry", labels: EXP_TOKEN },
  { kind: "due", labels: DUE_LABELS },
  { kind: "due", labels: ACT_BY_LABELS, label: sentenceCase },
  { kind: "due", labels: RENEWS_LABELS, label: () => "Renews" },
  { kind: "issued", labels: ISSUED_LABELS },
];

/**
 * The words for a moment. A travel word keeps the document's wording and its
 * meaning is read from it; the others state their label, what the date is,
 * and for a delivery the kind of document the line makes it.
 */
const EVENTS: {
  labels: RegExp;
  label?: (words: string) => string;
  role?: Role;
  document?: DocumentKind;
  lookBack?: boolean;
  only?: DocumentKind;
  /** Its departures and arrivals may belong to a flight the line names. */
  travel?: boolean;
}[] = [
  { labels: EVENT_LABELS, travel: true },
  { labels: START_LABELS, label: sentenceCase, role: "start", lookBack: true },
  { labels: DELIVERY_LABELS, label: () => "Delivery expected by", role: "by", document: "delivery" },
  { labels: ARRIVING_LABELS, label: () => "Delivery expected by", role: "by", document: "delivery", only: "delivery" },
];

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
function claimed(window: string, writtenAt?: number): { date: ParsedDate; time: string | null } | null {
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
  const below = parseDate(window, writtenAt === undefined ? undefined : { writtenAt });
  return below ? { date: below, time: parseTime(window) } : null;
}

// A flight's number as a line states it: after the word Flight ("Flight UA
// 123", "flight no. U2 45"), or standing right before the label ("UA 123
// departs"). The code is in capitals, and AM and PM before a label are a
// clock's.
const FLIGHT_NAMED = /\b(?:[Ff]light|FLIGHT|[Ff]lt\.?)\s*(?:[Nn]umber|[Nn]o\.?|#)?\s*([A-Z][A-Z0-9]|\d[A-Z])\s?(\d{1,4})\b(?!:)/;
const FLIGHT_BEFORE = /\b(?!AM\b|PM\b)([A-Z][A-Z0-9]|\d[A-Z])\s?(\d{1,4})\s+$/;
/** The airport a departure or an arrival names: three capitals right after the word. */
const AIRPORT_NEXT = /^\s*(?::|from|at|in|to)?\s*([A-Z]{3})\b/;

/**
 * The flight a departure or arrival label belongs to, when its own line
 * states one: the airline's code and number, and the airport right after
 * the label. With no flight number on the line, capitals after the label
 * are only a word, and no airport is named.
 */
function flightOn(text: string, at: number, length: number): { carrier: string; number: string; code: string; line: number } | undefined {
  const line = text.lastIndexOf("\n", at - 1) + 1;
  const stop = text.indexOf("\n", at);
  const end = stop === -1 ? text.length : stop;
  const stated = FLIGHT_NAMED.exec(text.slice(line, end)) ?? FLIGHT_BEFORE.exec(text.slice(line, at));
  const code = AIRPORT_NEXT.exec(text.slice(at + length, end));
  if (!stated || !code) {
    return undefined;
  }
  const service = serviceOf(`${stated[1]} ${stated[2]}`);
  return service.carrier && service.number ? { carrier: service.carrier, number: service.number, code: code[1]!, line } : undefined;
}

const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The same reach backwards, and never past the start of the label's own line. */
function windowBefore(text: string, to: number): string {
  const line = text.lastIndexOf("\n", to - 1) + 1;
  return text.slice(Math.max(line, to - WINDOW), to);
}

/** Dates that a document labelled, which is the only kind worth trusting. */
export function labelledFacts(text: string, writtenAt?: number): Fact[] {
  // How sure a date is: one that could be read two ways, or whose year the
  // message did not print, is a question for the owner.
  const sureness = (parsed: ParsedDate) => ({
    confidence: parsed.ambiguous || parsed.assumedYear ? 0.5 : 0.7,
    ...(parsed.ambiguous ? { ambiguous: true } : {}),
    ...(parsed.assumedYear ? { assumedYear: true } : {}),
  });
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();
  for (const { kind, labels, label } of KINDS) {
    labels.lastIndex = 0;
    for (let match = labels.exec(text); match; match = labels.exec(text)) {
      const parsed = claimed(windowAfter(text, match.index + match[0].length), writtenAt)?.date;
      if (!parsed) {
        continue;
      }
      const id = factId(kind, parsed.iso);
      if (byId.has(id)) {
        continue;
      }
      byId.set(id, {
        id,
        kind,
        document,
        value: parsed.iso,
        ...(label ? { label: label(match[0]) } : {}),
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
  for (const words of EVENTS) {
    if (words.only && words.only !== document) {
      continue;
    }
    words.labels.lastIndex = 0;
    for (let match = words.labels.exec(text); match; match = words.labels.exec(text)) {
      const after = windowAfter(text, match.index + match[0].length);
      const own = after.split("\n", 1)[0]!;
      const end = !words.travel ? undefined : /^depart/i.test(match[0]) ? "depart" : /^arriv/i.test(match[0]) ? "arrive" : undefined;
      const flight = end ? flightOn(text, match.index, match[0].length) : undefined;
      const flown = flight ? `${flight.line}|${flight.carrier}|${flight.number}` : "";
      let parsed: ParsedDate | null;
      let time: string | null;
      if (flight && end === "arrive" && !parseDate(own, writtenAt === undefined ? undefined : { writtenAt })) {
        // An arrival that names no day of its own lands on its departure's
        // day when its clock is the later one, or the day after when the
        // line says so. Otherwise its day is not known, and the lines
        // below are another matter: nothing is stated.
        const left = departed.get(flown);
        time = parseTime(own);
        const nextDay = /\+\s?1\b|\bnext\s+day\b/i.test(own);
        parsed = !left || !time ? null : nextDay ? { ...left.date, iso: dayAfter(left.date.iso) } : left.time && time > left.time ? left.date : null;
      } else {
        const ahead = claimed(after, writtenAt);
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
      if (byId.has(id)) {
        continue;
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
  const asked = amountDue(text, document);
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
 * they describe the paper, not the obligation.
 */
const REFUSED_LABELS = /\b(birth|born|dob\b|print|generat|creat|download|scan)/i;

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
export function structuralDatedFacts(text: string, claimed: ReadonlySet<string>): Fact[] {
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();
  for (const line of text.split(/\r?\n/)) {
    const field = FIELD_LINE.exec(line);
    // A colon between two digits is a clock's ("from 15:00 on 8 April"),
    // and the words before it are a sentence, not a label.
    const colon = line.indexOf(":");
    if (!field || (/\d/.test(line[colon - 1] ?? "") && /\d/.test(line[colon + 1] ?? ""))) {
      continue;
    }
    const label = field[1]!.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]/.test(label) || REFUSED_LABELS.test(label)) {
      continue;
    }
    const parsed = parseDate(field[2]!.slice(0, WINDOW));
    if (!parsed || claimed.has(parsed.iso)) {
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
      label: label.slice(0, MAX_LABEL_CHARS),
      source: "label",
      // Below a typed label, above bare harvesting: the anchor is real but
      // its meaning is the owner's to supply.
      confidence: 0.4,
      ...(parsed.ambiguous ? { ambiguous: true } : {}),
    });
  }
  return [...byId.values()];
}

const SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "¥": "JPY",
};

const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "CHF",
  "CNY", "SEK", "NZD", "SGD", "AED", "ZAR", "NOK", "DKK",
]);

const SYMBOL_AMOUNT = /([$£€₹¥])\s?([\d,]+\.\d{2})/g;
const CODE_AMOUNT = /\b([A-Z]{3})\s?([\d,]+\.\d{2})\b/g;

/** Every amount a piece of text states with its currency, once per value. */
function moneyIn(text: string): { value: string; unit: string }[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(SYMBOL_AMOUNT)) {
    found.set(match[2]!.replace(/,/g, ""), SYMBOL_CURRENCY[match[1]!] ?? match[1]!);
  }
  for (const match of text.matchAll(CODE_AMOUNT)) {
    if (CURRENCY_CODES.has(match[1]!)) {
      found.set(match[2]!.replace(/,/g, ""), match[1]!);
    }
  }
  return [...found].map(([value, unit]) => ({ value, unit }));
}

const AMOUNT_DUE_LINE = /\b(?:(?:amount|total|balance)\s+due|amount\s+payable|(?:is|are)\s+due)\b/i;
/** A statement's minimum is due as well as its balance: two answers to one question. */
const MINIMUM = /\bmin(?:imum|\.)?\s/i;

/**
 * The one amount a bill asks for: alone with its currency on a line that
 * says it is due. A line with two amounts, two lines that disagree, or a
 * minimum beside a balance name no single amount, and then none is stated.
 */
function amountDue(text: string, document: DocumentKind): Fact | undefined {
  const stated = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!AMOUNT_DUE_LINE.test(line)) {
      continue;
    }
    const onLine = moneyIn(line);
    if (onLine.length !== 1 || MINIMUM.test(line)) {
      return undefined;
    }
    stated.set(onLine[0]!.value, onLine[0]!.unit);
  }
  if (stated.size !== 1) {
    return undefined;
  }
  const [[value, unit]] = [...stated] as [[string, string]];
  return { id: factId("amount", value), kind: "amount", document, value, unit, label: "Amount due", source: "label", confidence: 0.7 };
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
