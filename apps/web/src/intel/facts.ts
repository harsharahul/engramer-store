/**
 * Typed facts read out of documents: an expiry, an amount due, a reference
 * number. Pure functions over strings, like categorize.ts, so the reading can
 * be tested without a browser and the rules stay readable.
 *
 * Two properties here are the whole design, not conveniences:
 *
 * A fact must be grounded in the document it claims to come from. Anything a
 * reader proposes that cannot be found in the source is discarded rather than
 * kept at a lower score. Today every fact comes from a rule that read the text
 * in the first place, so this costs nothing; it is the entire safety story
 * once a language model starts proposing facts, which is why it exists before
 * there is a model. The model proposes, the document decides.
 *
 * And a fact stays a suggestion until it is confirmed. A wrong expiry date is
 * worse than no expiry date, because it gets relied on.
 *
 * Full reference numbers never belong in a summary. Metadata is decrypted on
 * every device on every sync and held for the whole session; the last four
 * characters are enough to recognize a document, and the rest lives in the
 * per-file evidence blob behind an explicit reveal.
 */

export type FactKind =
  /** Something stops being valid on this date. */
  | "expiry"
  /** Something must be paid or filed by this date. */
  | "due"
  /** When the document was issued. */
  | "issued"
  /** A validity window. */
  | "period"
  /** A sum of money. */
  | "amount"
  /** A reference number. */
  | "identifier";

export type DocumentKind =
  | "passport"
  | "drivers-license"
  | "id-card"
  | "visa"
  | "residence-permit"
  | "insurance"
  | "warranty"
  | "membership"
  | "vehicle-registration"
  | "certification"
  | "invoice"
  | "other";

export type FactSource =
  /** AAMVA PDF417 on a driver's licence: structured fields, nothing guessed. */
  | "barcode"
  /** A machine-readable zone, validated by its own check digits. */
  | "mrz"
  /** A labelled date in extracted text. */
  | "label"
  /** Generic harvesting, the weakest signal. */
  | "pattern"
  /** Proposed by the local model, then grounded against the source. */
  | "model"
  /** Entered or corrected by hand. */
  | "user";

export interface Fact {
  /** Stable across rescans: file, kind and value. See factId. */
  id: string;
  kind: FactKind;
  document: DocumentKind;
  /** ISO date for date-shaped facts, a decimal string for amounts. */
  value: string;
  /** Currency for amounts, or the issuing authority. */
  unit?: string;
  /** Last four characters. The full value lives in the evidence blob. */
  masked?: string;
  source: FactSource;
  /** 0 to 1, assigned by source rather than estimated. */
  confidence: number;
  /** The date could be read two ways and the document did not say which. */
  ambiguous?: boolean;
  /** Pinned by the owner. Never overwritten by a later scan. */
  confirmed?: boolean;
  dismissed?: boolean;
  /** The contents this was read from, so a change can be noticed. */
  digest?: string;
  /** Confirmed, but the current contents no longer say it. */
  stale?: boolean;
}

/** The half that stays out of metadata, fetched only when a fact is opened. */
export interface FactEvidence {
  /** Matches Fact.id. */
  id: string;
  /** The complete reference number, of which the fact carries the last four. */
  full?: string;
  /** The passage the value was read from, so the fact can show its work. */
  span?: string;
  page?: number;
}

/** Metadata is synced everywhere; a document cannot grow it without bound. */
export const MAX_FACTS_PER_FILE = 12;

/**
 * Sources that read a structured field rather than surrounding prose. There is
 * no free text to ground them against, and their own check digits or fixed
 * field positions already proved them.
 */
const STRUCTURED: ReadonlySet<FactSource> = new Set(["barcode", "mrz", "user"]);

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

/** The last four characters, which is all a summary ever carries. */
export function maskTail(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

/** Stable across rescans, so a confirmation survives one. */
export function factId(fileId: string, kind: FactKind, value: string): string {
  return `${fileId}:${kind}:${value}`;
}

/**
 * Drops any fact whose value cannot be found in the document it came from.
 *
 * Separators and case are ignored on both sides, because a date is written a
 * dozen ways and none of the differences are meaningful here.
 */
export function groundFacts(facts: Fact[], source: string): Fact[] {
  const haystack = normalize(source);
  return facts.filter((fact) => {
    if (STRUCTURED.has(fact.source)) {
      return true;
    }
    return renderings(fact).some((form) => haystack.includes(normalize(form)));
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s.,/\\_-]+/g, "");
}

/** Every way a stored value might plausibly have been written. */
function renderings(fact: Fact): string[] {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fact.value);
  if (!iso) {
    return [fact.value];
  }
  const [, year, month, day] = iso as unknown as [string, string, string, string];
  const name = MONTHS[Number(month) - 1]!;
  const d = String(Number(day));
  const m = String(Number(month));
  const yy = year.slice(2);
  return [
    `${month}/${day}/${year}`,
    `${day}/${month}/${year}`,
    `${m}/${d}/${year}`,
    `${d}/${m}/${year}`,
    `${month}/${day}/${yy}`,
    `${day}/${month}/${yy}`,
    `${year}-${month}-${day}`,
    `${year}${month}${day}`,
    `${day} ${name} ${year}`,
    `${name} ${d} ${year}`,
    // A month and a year with no day: how cards and some permits print an
    // expiry. Looser than the rest on purpose, because refusing to ground a
    // real month-and-year expiry would be the worse failure.
    `${name} ${year}`,
  ];
}

/**
 * Folds a rescan into what a file already carries.
 *
 * A decision the owner made outranks anything a later scan finds: a confirmed
 * fact survives a rescan that no longer sees it, and a dismissed one is not
 * quietly brought back. Otherwise the stronger source wins, so a barcode read
 * replaces the guess a labelled date made about the same value.
 */
export function mergeFacts(existing: Fact[], found: Fact[]): Fact[] {
  const merged = new Map<string, Fact>();
  for (const fact of existing) {
    merged.set(fact.id, fact);
  }
  for (const fact of found) {
    const prior = merged.get(fact.id);
    if (!prior) {
      merged.set(fact.id, fact);
      continue;
    }
    if (prior.confirmed || prior.dismissed) {
      continue;
    }
    if (fact.confidence > prior.confidence) {
      merged.set(fact.id, fact);
    }
  }
  // The cap has to drop the weakest rather than whichever arrived last.
  return [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value))
    .slice(0, MAX_FACTS_PER_FILE);
}
