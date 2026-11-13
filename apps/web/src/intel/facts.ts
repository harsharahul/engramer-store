import { daysUntil } from "./dates";
import type { Subject } from "./subject";

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
  /** A parcel on its way: the delivery window from the carrier's data. */
  | "delivery"
  /** A table booked at a restaurant. */
  | "dining"
  | "other";

export type FactSource =
  /** AAMVA PDF417 on a driver's licence: structured fields, nothing guessed. */
  | "barcode"
  /** A machine-readable zone, validated by its own check digits. */
  | "mrz"
  /** schema.org reservation data a document carries about itself. */
  | "jsonld"
  /** A calendar invite's own event times (RFC 5545). */
  | "ics"
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
  /**
   * The document printed no year for this date: it is the next such day
   * after the message was written. It stays a question until the owner
   * answers, whoever else reads the same day.
   */
  assumedYear?: boolean;
  /** Pinned by the owner. Never overwritten by a later scan. */
  confirmed?: boolean;
  /**
   * Counts without the owner's yes, and on what basis: an exact reader
   * (booking data, a barcode, an invite, a passport's zone), two independent
   * readers agreeing, or a grounded reading from a reader whose measured
   * accuracy for this task allows it. Distinct from `confirmed`, so "the
   * owner said so" stays tellable apart from "the evidence said so".
   */
  accepted?: "exact" | "agreement" | "grounded";
  /** Which reader or readers produced this, for the line that says so. */
  reader?: string;
  /** Another reading of the same slot disagrees: the id of that fact. The
   * pair is offered once; the owner's answer settles both. */
  disputed?: string;
  dismissed?: boolean;
  /** The contents this was read from, so a change can be noticed. */
  digest?: string;
  /** Confirmed, but the current contents no longer say it. */
  stale?: boolean;
  /**
   * What the date is about, stated by the reader: which flight, stay or place.
   * Kept exactly as stored, so a subject a newer version wrote survives this
   * one; read it only through `subjectOf`, which checks it.
   */
  subject?: Subject;
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
  /** A link the sender gave for acting on this, such as an airline's check-in
   * page. Kept here because such links often carry the reference and a name. */
  link?: string;
}

/**
 * What a reader hands back: a fact, plus a link that must never be stored
 * with it. scanForFacts moves the link into evidence before facts leave it.
 */
export type ReadFact = Fact & { link?: string };

/**
 * Metadata is synced everywhere; a document cannot grow it without bound.
 *
 * Two bounds, because two things grow it. A long statement prints hundreds
 * of amounts and codes, and each is a soft reading: twelve of those are
 * kept. Exact data is as long as the booking that states it, and a package
 * of flights and hotels keeps all of its dates, references and prices, so
 * the whole list may hold thirty-two.
 */
export const MAX_FACTS_PER_FILE = 32;
export const MAX_SOFT_FACTS_PER_FILE = 12;

/** What a file may carry, from a list already in the order to keep it in. */
function capped<F extends Fact>(facts: F[]): F[] {
  let soft = 0;
  return facts.filter((fact) => fact.confidence >= 1 || soft++ < MAX_SOFT_FACTS_PER_FILE).slice(0, MAX_FACTS_PER_FILE);
}

/** Kinds that name a moment worth being reminded about. */
export const DATED_KINDS: ReadonlySet<string> = new Set(["expiry", "due", "event", "dated"]);

/** Whether a fact names such a moment, whoever read it. */
export function isDated(fact: Pick<Fact, "kind">): boolean {
  return DATED_KINDS.has(fact.kind);
}

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
): { fileId: string; fact: Fact; alternative?: Fact }[] {
  const offered: { fileId: string; fact: Fact; alternative?: Fact }[] = [];
  for (const file of files) {
    if (file.trashed) {
      continue;
    }
    const byId = new Map(file.facts.map((fact) => [fact.id, fact]));
    for (const fact of file.facts) {
      if (isTracked(fact) || fact.dismissed) {
        continue;
      }
      const partner = fact.disputed ? byId.get(fact.disputed) : undefined;
      if (partner && ownerDecided(partner)) {
        // Answered on the other side, perhaps by an older build that never
        // settled the pair: the question was asked once.
        continue;
      }
      if (!DATED_KINDS.has(fact.kind) && !partner) {
        continue;
      }
      if (DATED_KINDS.has(fact.kind) && daysUntil(fact.value, now) < -RECENT_PAST_OFFER_DAYS) {
        continue;
      }
      // A line that only names its date says nothing of a deadline. Once
      // its day is behind there is nothing left to be reminded of, so it is
      // not asked about; the line stays on the file, quietly.
      if (fact.kind === "dated" && daysUntil(fact.value, now) < 0) {
        continue;
      }
      if (partner) {
        // One question per disagreement, asked through the stronger reading.
        if (partner.confidence > fact.confidence || (partner.confidence === fact.confidence && partner.id < fact.id)) {
          continue;
        }
        offered.push({ fileId: file.id, fact, alternative: partner });
        continue;
      }
      offered.push({ fileId: file.id, fact });
    }
  }
  return offered;
}

/**
 * Sources that read a structured field rather than surrounding prose. There is
 * no free text to ground them against, and their own check digits or fixed
 * field positions already proved them.
 */
/**
 * Sources that state a fact rather than suggest it: exempt from prose
 * grounding, and at full confidence accepted without a yes.
 */
export const EXACT_SOURCES: ReadonlySet<FactSource> = new Set(["barcode", "mrz", "jsonld", "ics", "user"]);

/** Whether a fact counts: the owner confirmed it, or the evidence was accepted; never once dismissed. */
export function isTracked(fact: Fact): boolean {
  return !fact.dismissed && (fact.confirmed === true || fact.accepted !== undefined);
}

/** Whether the owner has answered this fact either way. */
export function ownerDecided(fact: Fact): boolean {
  return fact.confirmed === true || fact.dismissed === true;
}

/** Why a fact counts, for the line that says so; null while it waits for a yes. */
export function basisOf(fact: Fact): "confirmed" | "exact" | "agreement" | "grounded" | null {
  if (fact.dismissed) {
    return null;
  }
  return fact.confirmed ? "confirmed" : (fact.accepted ?? null);
}

/** An exact reader's full-confidence fact, which is accepted as it is read. */
export function withExactAcceptance(fact: Fact): Fact {
  return fact.accepted === undefined &&
    fact.confidence === 1 &&
    fact.source !== "user" &&
    EXACT_SOURCES.has(fact.source)
    ? { ...fact, accepted: "exact" }
    : fact;
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
  // A form line the owner answered under its own words, now read by what
  // its label means, is the same line: the answer stands and the typed
  // reading is not added beside it.
  const answered = answeredLines(existing);
  const retyped = new Set(rescanned.filter(answered).map(lineOf));
  const found = new Map(rescanned.filter((fact) => !answered(fact)).map((fact) => [fact.id, fact]));
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
      const forward: Fact = { ...withSubjectFrom(fact, again), digest };
      delete forward.stale;
      kept.push(forward);
      continue;
    }
    if (fact.confirmed && fact.kind === "dated" && retyped.has(lineOf(fact))) {
      // The new contents still hold the line; only its reading has a name now.
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
  return capped(kept);
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
  // Facts read before the accepted marker existed counted on their source
  // alone; they keep counting, and carry the marker from the next write.
  return capped(raw.filter(isFactShaped)).map(withExactAcceptance);
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
    if (EXACT_SOURCES.has(fact.source)) {
      return true;
    }
    const stated = fact.assumedYear
      ? statesMonthDay(fact.value, source)
      : renderings(fact).some((form) => haystack.includes(normalize(form))) || statesMonthYear(fact.value, source);
    if (!stated) {
      return false;
    }
    // A time has to be found too. A fact carrying the right date and a time
    // the document never mentions is exactly the plausible-looking error that
    // grounding exists to catch, and it is worse than the date alone because
    // it is the part someone would set an alarm by.
    if (fact.time !== undefined) {
      return (
        timeRenderings(fact.time).some((form) => haystack.includes(normalize(form))) ||
        statesHour(fact.time, source) ||
        statesMorningClock(fact.time, source)
      );
    }
    return true;
  });
}

/** The ways a month is written: its name, its first three letters, and Sept. */
function monthForms(name: string): string[] {
  return [...new Set([name, name.slice(0, 3), ...(name === "september" ? ["sept"] : [])])];
}

/**
 * Whether the document prints this date's month and year with no day, as
 * cards and some permits print an expiry ("Valid thru Nov 2026"). Looser
 * than a full date on purpose: refusing a real month-and-year expiry would
 * be the worse failure. But only where no day stands before the month: in
 * "14 Nov 2026" the document names its day, and any other day of that
 * month is a wrong reading, not a loose one.
 */
function statesMonthYear(isoDate: string, source: string): boolean {
  const parts = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!parts) {
    return false;
  }
  const month = `(?:${monthForms(MONTHS[Number(parts[2]) - 1]!).join("|")})`;
  return new RegExp(`(?<!\\d(?:st|nd|rd|th)?[\\s.,-]{1,3})\\b${month}\\.?,?\\s+${parts[1]}\\b`, "i").test(source);
}

/**
 * Whether the document writes this month and day with no year ("November
 * 12", "Thu 12 Nov", "Nov. 12th"). Read as a date in the text itself, so the
 * 12th is never found in "November 120" or in the 2nd.
 */
function statesMonthDay(isoDate: string, source: string): boolean {
  const parts = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!parts) {
    return false;
  }
  const month = `(?:${monthForms(MONTHS[Number(parts[1]) - 1]!).join("|")})\\.?`;
  const day = `0?${Number(parts[2])}(?:st|nd|rd|th)?`;
  return new RegExp(`\\b${month}\\s+${day}\\b(?!\\d)|(?<!\\d)\\b${day}\\s+${month}(?![a-z])`, "i").test(source);
}

/**
 * Whether the document writes this whole hour without a colon ("3pm",
 * "11 a.m."). Read as a clock in the text itself and not as a run of
 * characters, so "3pm" is never found in the tail of "12:03pm".
 */
function statesHour(time: string, source: string): boolean {
  const [hh, mm] = time.split(":") as [string, string];
  if (mm !== "00") {
    return false;
  }
  const hour = Number(hh);
  const half = hour % 12 === 0 ? 12 : hour % 12;
  return new RegExp(`(?<![\\d.:,])\\b${half}\\s?${hour < 12 ? "a" : "p"}\\.?m(?![A-Za-z])`, "i").test(source);
}

/**
 * Whether the document writes this morning clock with one digit for its
 * hour ("9:40"). Read as a clock in the text itself, so it is never found
 * in the tail of "19:40", and never where the text says it of the evening
 * ("9:40 PM").
 */
function statesMorningClock(time: string, source: string): boolean {
  const [hh, mm] = time.split(":") as [string, string];
  if (!hh.startsWith("0")) {
    return false;
  }
  return new RegExp(`(?<![\\d.:,])${Number(hh)}:${mm}(?!\\d)(?!\\s?p\\.?m(?![a-z]))`, "i").test(source);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s.,/\\_:-]+/g, "");
}

/** Whether the document states this phrase, by the same measure dates are grounded with. */
export function isStated(phrase: string, source: string): boolean {
  const wanted = normalize(phrase);
  return wanted.length > 0 && normalize(source).includes(wanted);
}

/**
 * The two ways a time is written, and deliberately not a third.
 *
 * The unpadded twenty-four hour form ("9:40") is left out: once separators are
 * stripped it is a substring of "19:40", so including it would ground an
 * evening fact against a morning document. That form is looked for in the
 * text as a clock instead (`statesMorningClock`).
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
  const d = String(Number(day));
  const m = String(Number(month));
  const yy = year.slice(2);
  const tens = Number(day) % 100;
  const th = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][Number(day) % 10] ?? "th");
  return [
    `${month}/${day}/${year}`,
    `${day}/${month}/${year}`,
    `${m}/${d}/${year}`,
    `${d}/${m}/${year}`,
    `${month}/${day}/${yy}`,
    `${day}/${month}/${yy}`,
    `${year}-${month}-${day}`,
    `${year}${month}${day}`,
    // Written months, as the name or its short form ("14 Nov 2026" is how
    // most mail writes a date), with the day bare, zero-padded and as an
    // ordinal: documents print "April 2", "April 02" and "April 2nd"
    // interchangeably, and a fact discarded because of how its day is
    // written would be grounding failing at its own job.
    ...monthForms(MONTHS[Number(month) - 1]!).flatMap((name) => [
      `${day} ${name} ${year}`,
      `${d} ${name} ${year}`,
      `${d}${th} ${name} ${year}`,
      `${name} ${d} ${year}`,
      `${name} ${day} ${year}`,
      `${name} ${d}${th} ${year}`,
      // The year-first written form some documents use.
      `${year} ${name} ${d}`,
      `${year} ${name} ${day}`,
    ]),
  ];
}

/** A form line by its day and its label, however the label is spaced or cased. */
function lineOf(fact: Pick<Fact, "value" | "label">): string {
  return `${fact.value}|${(fact.label ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()}`;
}

/**
 * Tells a typed reading of a form line the owner already answered, yes or
 * no, while the line only named its date. The answer was for that line: a
 * reading of the same day under another label is another line.
 */
function answeredLines(existing: readonly Fact[]): (fact: Fact) => boolean {
  const lines = new Set(existing.filter((fact) => fact.kind === "dated" && ownerDecided(fact)).map(lineOf));
  return (fact) => fact.source === "label" && MEANT_KINDS.has(fact.kind) && lines.has(lineOf(fact));
}

/**
 * What a file carries, less the form lines the rules no longer read.
 *
 * A line that only names its date comes from the text alone, so reading the
 * same text again is the whole truth about it. Where its label has since
 * been given a meaning that needs no reminder ("Statement date"), the line
 * is not read any more and the stored one goes with it. A line the owner
 * answered stays, and so does every other reader's fact.
 */
export function withoutUnreadLines(existing: readonly Fact[], rescanned: readonly Fact[]): Fact[] {
  const again = new Set(rescanned.map((fact) => fact.id));
  return existing.filter((fact) => !(fact.kind === "dated" && fact.source === "label" && !ownerDecided(fact) && !again.has(fact.id)));
}

/**
 * Folds a rescan into what a file already carries, in one fixed order.
 *
 * A decision the owner made outranks anything a later scan finds: a confirmed
 * fact survives a rescan that no longer sees it, and a dismissed one is not
 * quietly brought back. Then an exact reader outranks every softer one. Two
 * independent readers that state the same value agree, and the fact counts.
 * Where one slot (a due date, an expiry, an amount due) is read two ways:
 * the owner's answer or an exact reading settles it; otherwise a model and a
 * label rule that disagree are kept as a pair and asked about once.
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
  // A form line the owner answered under its own words, yes or no, is
  // settled. The same line read later by what its label means is not news,
  // and is not asked about under a new name.
  const answered = answeredLines(existing);
  for (const fact of existing) {
    merged.set(fact.id, fact);
  }
  for (const fact of found) {
    const prior = merged.get(fact.id);
    if (!prior) {
      if (answered(fact)) {
        continue;
      }
      if (!confirmedValues.has(`${fact.kind}:${fact.value}`)) {
        merged.set(fact.id, fact);
        continue;
      }
      // The owner already said this date under other words. What the same
      // reader now says it is still applies to the owner's fact.
      const owned = [...merged.values()].find(
        (other) =>
          other.confirmed && !other.subject && other.kind === fact.kind && other.value === fact.value && other.time === fact.time,
      );
      if (owned) {
        merged.set(owned.id, withSubjectFrom(owned, fact));
      }
      continue;
    }
    if (prior.dismissed) {
      continue;
    }
    if (prior.confirmed) {
      // The owner's answer stands; only the reader's statement of meaning moves.
      merged.set(fact.id, withSubjectFrom(prior, fact));
      continue;
    }
    merged.set(fact.id, withSubjectFrom(pick(prior, fact), fact));
  }
  // The cap has to drop the weakest rather than whichever arrived last.
  return capped(
    resolveSlots([...merged.values()]).sort((a, b) => b.confidence - a.confidence || capRank(a) - capRank(b) || a.value.localeCompare(b.value)),
  );
}

/**
 * What the cap keeps first among exact readings: a date makes a row, a
 * reference links one file to another, and a price only adds to them. Softer
 * readings keep the order they had; their confidence already ranks them.
 */
function capRank(fact: Fact): number {
  if (fact.confidence < 1) {
    return 0;
  }
  return fact.kind === "amount" ? 2 : fact.kind === "identifier" ? 1 : 0;
}

/** Kinds a document states once: two different readings of one disagree. */
const SLOT_KINDS: ReadonlySet<FactKind> = new Set(["expiry", "due", "issued", "amount"]);
/** Of all the amounts a document prints, the one it asks to be paid. */
const TOTAL_LABEL = /due|total|balance|pay/i;
/** Readers whose answers are grounded but not exact; two of them can agree or disagree. */
const GROUNDED_READERS: ReadonlySet<FactSource> = new Set(["model", "label"]);

function slotOf(fact: Fact): string | undefined {
  if (!SLOT_KINDS.has(fact.kind)) {
    return undefined;
  }
  if (fact.kind === "amount") {
    return TOTAL_LABEL.test(fact.label ?? "") ? "amount" : undefined;
  }
  return fact.kind;
}

/** Kinds that say what a date is; a form line that only names a date does not. */
const MEANT_KINDS: ReadonlySet<FactKind> = new Set(["event", "due", "expiry", "issued"]);

/**
 * What a file's readers already gave a meaning, so the model is not asked
 * about it again: each date a rule, booking data or the owner settled (with
 * its clock when it has one), and whether a reader named the total. The
 * model's own earlier reading does not count: a new reading judges it afresh,
 * unless the owner answered it. A form line that only names a date has no
 * meaning yet, so the model is asked what it is; once the owner answered that
 * line, yes or no, the day is settled and is not asked about under new words.
 */
export function alreadyRead(facts: readonly Fact[]): { read: { value: string; time?: string }[]; total: boolean } {
  const settled = facts.filter((fact) => fact.source !== "model" || ownerDecided(fact));
  const read = settled.filter((fact) => MEANT_KINDS.has(fact.kind) || (fact.kind === "dated" && ownerDecided(fact)));
  return {
    read: read.map((fact) => ({ value: fact.value, ...(fact.time ? { time: fact.time } : {}) })),
    total: settled.some((fact) => slotOf(fact) === "amount"),
  };
}

/** Whether two readings of a slot could be the same thing said two ways: an
 * amount with no currency matches any; two named currencies must agree. */
function comparable(a: Fact, b: Fact): boolean {
  return a.kind !== "amount" || !a.unit || !b.unit || a.unit === b.unit;
}

function isExact(fact: Fact): boolean {
  return withExactAcceptance(fact).accepted === "exact";
}

function readers(fact: Fact): string[] {
  return (fact.reader ?? fact.source).split(" + ");
}

/** The same reading from two readers: exact wins; two grounded readers agree. */
/**
 * A stored fact with the subject a fresh reading by the same reader stated.
 * The subject is the reader's own statement, unlike a confirmation, so the
 * newest reading of it wins; a different reader never rewrites it.
 */
function withSubjectFrom(kept: Fact, fresh: Fact): Fact {
  return fresh.subject && kept !== fresh && kept.source === fresh.source ? { ...kept, subject: fresh.subject } : kept;
}

function pick(prior: Fact, fact: Fact): Fact {
  if (isExact(prior) !== isExact(fact)) {
    return isExact(prior) ? prior : withExactAcceptance(fact);
  }
  const winner = fact.confidence > prior.confidence ? fact : prior;
  // An ambiguous date stays a question even when a second reader picked the
  // same reading: both may have guessed the day and month the same wrong way.
  if (
    GROUNDED_READERS.has(prior.source) &&
    GROUNDED_READERS.has(fact.source) &&
    prior.source !== fact.source &&
    !prior.ambiguous &&
    !fact.ambiguous &&
    // Nor does a second reader settle which year a date with none means.
    !prior.assumedYear &&
    !fact.assumedYear
  ) {
    const names = [...new Set([...readers(prior), ...readers(fact)])].sort();
    return { ...winner, accepted: winner.accepted ?? "agreement", reader: names.join(" + ") };
  }
  return winner;
}

/** Settles each slot read more than one way, or marks the disagreement to ask about. */
function resolveSlots(facts: Fact[]): Fact[] {
  const ids = new Set(facts.map((fact) => fact.id));
  let out = facts.map((fact) => {
    if (fact.disputed && !ids.has(fact.disputed)) {
      const { disputed: _gone, ...rest } = fact;
      return rest;
    }
    return fact;
  });
  const slots = new Map<string, Fact[]>();
  for (const fact of out) {
    const slot = slotOf(fact);
    if (slot && !fact.dismissed) {
      slots.set(slot, [...(slots.get(slot) ?? []), fact]);
    }
  }
  const drop = new Set<string>();
  const marks = new Map<string, string>();
  for (const group of slots.values()) {
    if (new Set(group.map((fact) => fact.value)).size < 2) {
      continue;
    }
    // The owner's answer settles the slot outright; an exact reading settles
    // it against every softer one.
    const confirmed = group.find((fact) => fact.confirmed);
    const exact = group.find(isExact);
    if (confirmed || exact) {
      // The model's guesses give way to either; exact data gives way only to
      // the owner's answer. A rule's reading of another date in the same slot
      // may be a second real date (an installment, a visa beside the
      // passport) and stays to be asked about.
      const settler = (confirmed ?? exact)!;
      for (const fact of group) {
        const yields = fact.source === "model" || (confirmed !== undefined && isExact(fact));
        if (yields && !ownerDecided(fact) && fact.value !== settler.value && comparable(fact, settler)) {
          drop.add(fact.id);
        }
      }
      continue;
    }
    const best = (source: FactSource) =>
      group.filter((fact) => fact.source === source).sort((a, b) => b.confidence - a.confidence)[0];
    const model = best("model");
    const label = best("label");
    if (model && label && model.value !== label.value && comparable(model, label)) {
      marks.set(model.id, label.id);
      marks.set(label.id, model.id);
    }
  }
  // Booking data, an invite or a barcode that states an event on a date is
  // the record of that day's booking in this file; the model's own reading
  // of an event that day (its own label, often its own clock) is an echo.
  const exactDays = new Set(out.filter((fact) => fact.kind === "event" && !fact.dismissed && isExact(fact)).map((fact) => fact.value));
  // A moment a label rule read is that moment in this file, asked about (or
  // already answered) under the rule's own words. The model is asked about
  // every date in the text, so its reading of the same day and clock is the
  // same moment again, not a second witness and not a second question.
  const ruled = out.filter((fact) => fact.kind === "event" && fact.source === "label");
  const echoes = (fact: Fact) =>
    exactDays.has(fact.value) || ruled.some((rule) => rule.value === fact.value && (!rule.time || !fact.time || rule.time === fact.time));
  for (const fact of out) {
    if (fact.kind === "event" && fact.source === "model" && !ownerDecided(fact) && echoes(fact)) {
      drop.add(fact.id);
    }
  }
  // A form line that only names a date ("Date: 15 May 2027") says nothing of
  // what the date is. Where the model says what it is, or a rule now reads
  // the line by what its label means, that is the reading of that day,
  // answered or not: one date, one question.
  const meant = new Set(
    out
      .filter(
        (fact) =>
          !drop.has(fact.id) &&
          ((fact.source === "model" && (fact.kind === "event" || fact.kind === "due" || fact.kind === "expiry")) ||
            (fact.source === "label" && MEANT_KINDS.has(fact.kind))),
      )
      .map((fact) => fact.value),
  );
  for (const fact of out) {
    if (fact.kind === "dated" && fact.source === "label" && !ownerDecided(fact) && meant.has(fact.value)) {
      drop.add(fact.id);
    }
  }
  out = out.filter((fact) => !drop.has(fact.id));
  return out.map((fact) => {
    const other = marks.get(fact.id);
    if (!other) {
      return fact;
    }
    const { accepted: _none, ...rest } = fact;
    return { ...rest, disputed: other };
  });
}

/**
 * The owner's answer to a disagreement: the confirmed reading stands, its
 * partner is dismissed, and neither is marked disputed any more. Ignoring
 * the question dismisses both: it was asked once.
 */
export function settleDisputes(facts: Fact[]): Fact[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const dismiss = new Set<string>();
  const release = new Set<string>();
  for (const fact of facts) {
    if (!fact.disputed || !byId.has(fact.disputed)) {
      continue;
    }
    if (fact.confirmed) {
      dismiss.add(fact.disputed);
      release.add(fact.id);
      release.add(fact.disputed);
    } else if (fact.dismissed) {
      // "Ignore" answers the question, not one side of it.
      dismiss.add(fact.disputed);
      release.add(fact.id);
      release.add(fact.disputed);
    }
  }
  return facts.map((fact) => {
    if (!release.has(fact.id)) {
      return fact;
    }
    const { disputed: _settled, ...rest } = fact;
    return dismiss.has(fact.id) ? { ...rest, dismissed: true } : rest;
  });
}
