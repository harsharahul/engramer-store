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
import { parseDate, parseTime } from "./dates";

/** How far past a label to look for its date. */
const WINDOW = 60;

/** A blank line ends a thought, so a label never reaches into the next one. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

const EXPIRY_LABELS =
  /\b(?:date\s+of\s+expiry|expir(?:es|y|ation)(?:\s+date)?|valid\s+(?:until|through|to)|renewal\s+date|good\s+through)\b/gi;
const DUE_LABELS =
  /\b(?:payment\s+due|amount\s+due\s+by|due\s+date|due\s+on|pay\s+by)\b/gi;
const ISSUED_LABELS = /\b(?:date\s+of\s+issue|issue\s+date|issued(?:\s+on)?)\b/gi;

/**
 * Moments rather than deadlines, which is what travel documents are made of.
 * These get the same window discipline as the deadline labels, plus a time
 * when the window carries one.
 */
const EVENT_LABELS =
  /\b(?:check[- ]?in|check[- ]?out|departure|departs|boarding(?:\s+time)?|arrival|arrives|pick[- ]?up|drop[- ]?off)\b/gi;

const KINDS: { kind: Fact["kind"]; labels: RegExp }[] = [
  { kind: "expiry", labels: EXPIRY_LABELS },
  { kind: "due", labels: DUE_LABELS },
  { kind: "issued", labels: ISSUED_LABELS },
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

/** Dates that a document labelled, which is the only kind worth trusting. */
export function labelledFacts(text: string): Fact[] {
  const document = guessDocumentKind(text);
  const byId = new Map<string, Fact>();
  for (const { kind, labels } of KINDS) {
    labels.lastIndex = 0;
    for (let match = labels.exec(text); match; match = labels.exec(text)) {
      const parsed = parseDate(windowAfter(text, match.index + match[0].length));
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
        source: "label",
        // A date that could be read two ways is worth less than one that
        // could not, and the difference is what the confirmation card asks
        // about rather than something to resolve here.
        confidence: parsed.ambiguous ? 0.5 : 0.7,
        ...(parsed.ambiguous ? { ambiguous: true } : {}),
      });
    }
  }
  EVENT_LABELS.lastIndex = 0;
  for (let match = EVENT_LABELS.exec(text); match; match = EVENT_LABELS.exec(text)) {
    const window = windowAfter(text, match.index + match[0].length);
    const parsed = parseDate(window);
    if (!parsed) {
      continue;
    }
    const label = match[0].trim();
    // The label joins the identity: a check-in and a check-out can share a
    // day, and a date alone would collapse them into one fact.
    const id = factId("event", `${parsed.iso} ${label.toLowerCase()}`);
    if (byId.has(id)) {
      continue;
    }
    const time = parseTime(window);
    byId.set(id, {
      id,
      kind: "event",
      document,
      value: parsed.iso,
      label,
      ...(time ? { time } : {}),
      source: "label",
      confidence: parsed.ambiguous ? 0.5 : 0.7,
      ...(parsed.ambiguous ? { ambiguous: true } : {}),
    });
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
    if (!field) {
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
const TOKEN = /\b[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;

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
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) {
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
