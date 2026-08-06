import { daysUntil } from "./dates";

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
  | "identifier"
  /** Something happens at this date, and often at a time: a departure, a
   * check-in, an appointment. Unlike an expiry it is not a deadline that
   * passes quietly; it is a thing to be somewhere for. */
  | "event"
  /**
   * A labelled date whose meaning the system does not know.
   *
   * The label vocabulary can never be finished: one benefits form says "Valid Till",
   * a gym contract says something else, and a Korean tax form says it in
   * Korean. What generalizes is the structure, a label beside a date, plus
   * the owner reading their own document's words. So the label rides along
   * verbatim in `label`, the card quotes it, and the human supplies the
   * meaning once. Rules never read these; they need semantics.
   */
  | "dated";

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
  // Travel. Nothing produces these yet; they are named here because the kind
  // is stored inside encrypted metadata, and agreeing on the vocabulary
  // before anything writes it is what keeps a later reader from meeting a
  // value it has never heard of.
  | "boarding-pass"
  | "hotel-booking"
  | "itinerary"
  | "car-rental"
  | "event-ticket"
  | "other";

export type FactSource =
  /** AAMVA PDF417 on a driver's licence: structured fields, nothing guessed. */
  | "barcode"
  /** A machine-readable zone, validated by its own check digits. */
  | "mrz"
  /** schema.org reservation data a document carries about itself. */
  | "jsonld"
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
  /**
   * A time of day as "HH:MM", where the document gave one.
   *
   * Local to whatever the document is talking about, and kept separate from
   * the date rather than folded into an instant. A departure printed on a
   * ticket is the time at that airport; converting it to UTC without knowing
   * the airport's zone would produce an answer that looks precise and is
   * hours wrong, which is exactly the kind of confident error this whole
   * design refuses to make.
   */
  time?: string;
  /** The IANA zone the time belongs to, or the fixed offset the document
   * itself printed, on the rare occasion either is genuinely known. */
  zone?: string;
  /** The document's own words for what this date is, verbatim. Always set on
   * "dated" facts, since the label is the only meaning they carry. */
  label?: string;
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

/** Kinds that name a moment worth being reminded about. */
export const DATED_KINDS: ReadonlySet<string> = new Set(["expiry", "due", "event", "dated"]);

/**
 * A deadline slightly past is still actionable; one long past is history.
 * An invoice due last week is worth surfacing, a licence that expired in
 * 2019 is not a reminder, it is an archive.
 */
export const RECENT_PAST_OFFER_DAYS = 60;

/**
 * The facts worth asking the owner about: unanswered, dated, and not stale
 * history.
 *
 * The future-only filter is what keeps a bulk upload from burying the
 * screen. A thousand old documents carry mostly past dates: print dates,
 * old due dates, spent expiries. None of them is a deadline anymore, so
 * none is offered; the facts still exist on each file, quietly. What
 * survives this filter is the small set of dates that are still ahead of
 * the owner, which is the only set worth their attention.
 */
export function offeredFacts(
  files: { id: string; trashed: boolean; facts: Fact[] }[],
  now: number,
): { fileId: string; fact: Fact }[] {
  const offered: { fileId: string; fact: Fact }[] = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    for (const fact of file.facts) {
      if (fact.confirmed || fact.dismissed || !DATED_KINDS.has(fact.kind)) {
        continue;
      }
      if (daysUntil(fact.value, now) < -RECENT_PAST_OFFER_DAYS) {
        continue;
      }
      offered.push({ fileId: file.id, fact });
    }
  }
  return offered;
}

/**
 * The nearest date a file is actually tracking, or nothing if it tracks none.
 * Only confirmed facts count: an unconfirmed reading has not been agreed to,
 * and listing a file by a date nobody accepted would be acting on a guess.
 */
export function soonestDated(facts: Fact[]): string | undefined {
  let soonest: string | undefined;
  for (const fact of facts) {
    if (!fact.confirmed || fact.dismissed || !DATED_KINDS.has(fact.kind)) {
      continue;
    }
    if (soonest === undefined || fact.value < soonest) {
      soonest = fact.value;
    }
  }
  return soonest;
}

/**
 * Sources that read a structured field rather than surrounding prose. There is
 * no free text to ground them against, and their own check digits or fixed
 * field positions already proved them.
 */
const STRUCTURED: ReadonlySet<FactSource> = new Set(["barcode", "mrz", "jsonld", "user"]);

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

/**
 * Stable across rescans, so a confirmation survives one.
 *
 * Scoped to the file it lives in and nothing wider, because that is the only
 * scope a fact has: it is stored inside one file's metadata and only ever
 * compared with that file's other facts. It also cannot be any wider, since a
 * file's identity is assigned by the server after the reading is already done.
 */
export function factId(kind: FactKind, value: string): string {
  return `${kind}:${value}`;
}

/**
 * Folds a rescan into what a file carried, after its contents changed.
 *
 * Version history is not limited to office documents: any file whose contents
 * are replaced keeps its previous generation, so a note, a spreadsheet and a
 * re-saved PDF all pass through here. A fact describes contents, and the
 * contents just changed, so every fact has to answer for itself.
 *
 * The case that matters is the middle one. A confirmed fact the new contents
 * no longer support is kept and marked, not deleted and not left asserting
 * something the document stopped saying. Deleting it would take away a
 * reminder the owner asked for, without telling them; keeping it unmarked
 * would put words in the document's mouth. Neither is acceptable, so it is
 * kept, flagged, and reported.
 *
 * A stale fact keeps the digest it was actually read from rather than taking
 * the new one, because that is where it came from and pretending otherwise
 * would lose the only evidence of the disagreement.
 */
export function reconcileFacts(existing: Fact[], rescanned: Fact[], digest: string): Fact[] {
  const found = new Map(rescanned.map((fact) => [fact.id, fact]));
  const kept: Fact[] = [];
  for (const fact of existing) {
    const again = found.get(fact.id);
    found.delete(fact.id);
    if (fact.dismissed) {
      // A tombstone. Whether the contents still say it is beside the point:
      // the owner put it away, and a rescan is not a reason to ask again.
      kept.push(fact);
      continue;
    }
    if (again) {
      const forward: Fact = { ...fact, digest };
      delete forward.stale;
      kept.push(forward);
      continue;
    }
    if (fact.confirmed) {
      kept.push({ ...fact, stale: true });
    }
    // An unconfirmed fact that lost its evidence simply goes. Nothing was
    // relying on it, and re-offering a suggestion the document no longer
    // supports would be worse than silence.
  }
  for (const fresh of found.values()) {
    kept.push({ ...fresh, digest });
  }
  return kept.slice(0, MAX_FACTS_PER_FILE);
}

/**
 * Facts as they come back out of decrypted metadata.
 *
 * The check is structural, not a vocabulary check, and that distinction
 * matters: a client meeting a `kind` it has never heard of keeps it and stores
 * it back unchanged, because metadata is rewritten from what was read and
 * rejecting an unfamiliar value here would silently delete something a newer
 * version wrote. Rules simply never match a kind they do not know, which is
 * the right place for that ignorance to live.
 */
export function asFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isFactShaped).slice(0, MAX_FACTS_PER_FILE);
}

function isFactShaped(value: unknown): value is Fact {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Fact>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.document === "string" &&
    typeof candidate.value === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.confidence === "number"
  );
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
    if (!renderings(fact).some((form) => haystack.includes(normalize(form)))) {
      return false;
    }
    // A time has to be found too. A fact carrying the right date and a time
    // the document never mentions is exactly the plausible-looking error that
    // grounding exists to catch, and it is worse than the date alone because
    // it is the part someone would set an alarm by.
    if (fact.time !== undefined) {
      return timeRenderings(fact.time).some((form) => haystack.includes(normalize(form)));
    }
    return true;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s.,/\\_:-]+/g, "");
}

/**
 * The two ways a time is written, and deliberately not a third.
 *
 * The unpadded twenty-four hour form ("9:40") is left out: once separators are
 * stripped it is a substring of "19:40", so including it would ground an
 * evening fact against a morning document. Missing a real match is the safer
 * direction to be wrong in.
 */
function timeRenderings(time: string): string[] {
  const [hh, mm] = time.split(":") as [string, string];
  const hour = Number(hh);
  const half = hour % 12 === 0 ? 12 : hour % 12;
  return [`${hh}:${mm}`, `${half}:${mm}${hour < 12 ? "am" : "pm"}`];
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
    // Written months, with the day both bare and zero-padded: documents
    // print "April 2" and "April 02" interchangeably, and a fact discarded
    // because of a leading zero would be grounding failing at its own job.
    `${day} ${name} ${year}`,
    `${d} ${name} ${year}`,
    `${name} ${d} ${year}`,
    `${name} ${day} ${year}`,
    // The year-first written form some documents use.
    `${year} ${name} ${d}`,
    `${year} ${name} ${day}`,
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
  // Values the owner already confirmed, under whatever identity. A fact
  // corrected from 10 May to 19 October keeps its original id, so a later
  // rescan finds 19 October under a new id and would offer it as news; the
  // owner already said it, so it is not.
  const confirmedValues = new Set(
    existing.filter((fact) => fact.confirmed).map((fact) => `${fact.kind}:${fact.value}`),
  );
  for (const fact of existing) {
    merged.set(fact.id, fact);
  }
  for (const fact of found) {
    const prior = merged.get(fact.id);
    if (!prior) {
      if (!confirmedValues.has(`${fact.kind}:${fact.value}`)) {
        merged.set(fact.id, fact);
      }
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
