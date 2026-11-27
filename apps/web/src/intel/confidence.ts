/**
 * When a reading counts without the owner's yes.
 *
 * Confidence is computed, never the model's own report: an exact source
 * counts as read; agreement between two readers is decided where readings
 * merge (facts.ts); a model reading alone counts only for a task where the
 * reader's precision, measured on both eval sets (the first, and the
 * held-out one nothing was tuned on) over enough readings and for this
 * version of the reader, is at least 98%, only when the stakes allow
 * one reader, and only when the value passes the sanity checks. Scores count
 * only for the reader version and the exact prompt they were measured with.
 * Everything else waits for a yes.
 */

import { isRealDate } from "./dates";
import { billAmountOf, EXACT_SOURCES, type Fact } from "./facts";
import { READER_VERSION } from "./reading";
import { subjectOf } from "./subject";
import { readingFingerprint } from "./summarize";
import shippedRules from "./eval/rulescores.json";
import shipped from "./eval/scores.json";

export type Stakes = "high" | "normal" | "low";

/** Measured precision this high, or a model reading is not trusted alone. */
export const PRECISION_BAR = 0.98;
/** Readings a precision must rest on before it means anything. */
export const MIN_SAMPLE = 30;

const IDENTITY_DOCUMENTS = new Set(["passport", "visa", "residence-permit", "id-card", "drivers-license"]);
const TRAVEL_TIME = /\b(?:depart|departs|arrive|arrives|flight|boarding)\b/i;
const LEGAL = /\b(?:deadline|court|filing|hearing)\b/i;
const YEARS = 20;
const DAY = 86_400_000;

export interface TaskScore {
  precision: number;
  recall: number;
  offered: number;
  expected: number;
}

export interface ReaderScores {
  reader: string;
  version: number;
  /** The reading request measured (readingFingerprint), absent in older scores. */
  prompt?: string;
  tasks: {
    dates?: TaskScore;
    amounts?: TaskScore;
    mailKind?: { accuracy: number; cases: number; byKind?: Record<string, { precision: number; offered: number }> };
  };
  /**
   * The same tasks measured on the held-out set: documents no rule and no
   * instruction was ever tuned on. A reading counts alone only where both
   * sets clear the bar; absent in older scores, which then trust nothing.
   */
  heldout?: { cases: number; tasks: { dates?: TaskScore; amounts?: TaskScore } };
}

/** How often an email's kind must be named right before the kind is used. */
export const KIND_BAR = 0.9;
/** Cases a kind accuracy must rest on. */
export const MIN_KIND_CASES = 20;

/** How much a wrong value would cost: high needs exact evidence or agreement. */
export function stakesOf(fact: Fact): Stakes {
  const label = fact.label ?? "";
  if (fact.kind === "expiry" && IDENTITY_DOCUMENTS.has(fact.document)) {
    return "high";
  }
  // Any travel word counts, on top of a stated departure or arrival: stakes
  // err high, whoever wrote the label.
  const role = subjectOf(fact)?.role;
  if (fact.kind === "event" && (role === "depart" || role === "arrive" || TRAVEL_TIME.test(label))) {
    return "high";
  }
  if (LEGAL.test(label)) {
    return "high";
  }
  if (fact.kind === "amount" || fact.document === "delivery" || fact.document === "dining") {
    return "low";
  }
  return "normal";
}

/** Checks a value must pass before it can count on one reader's word. */
export function saneFact(fact: Fact, siblings: readonly Fact[], now: number): boolean {
  if (fact.kind === "amount") {
    return Boolean(fact.unit) && Number(fact.value) > 0;
  }
  if (!isRealDate(fact.value)) {
    return false;
  }
  const at = Date.parse(`${fact.value}T00:00:00Z`);
  if (Math.abs(at - now) > YEARS * 365 * DAY) {
    return false;
  }
  // A stay ends after it begins.
  const subject = subjectOf(fact);
  if (subject?.role === "check-out") {
    const place = subject.place?.toLowerCase();
    const checkin = siblings.find((other) => {
      const begins = subjectOf(other);
      return begins?.role === "check-in" && begins.place?.toLowerCase() === place;
    });
    if (checkin && checkin.value > fact.value) {
      return false;
    }
  }
  return true;
}

/** The scores measured for the model reader this build ships (tools/eval/apple). */
export function modelScores(): ReaderScores {
  return shipped as ReaderScores;
}

/** Scores measured for this version of the reader and this exact prompt. */
function current(scores: ReaderScores | undefined): scores is ReaderScores {
  return scores !== undefined && scores.version === READER_VERSION[scores.reader] && scores.prompt === readingFingerprint();
}

/** Whether the model's naming of an email's kind is stored as a tag. */
export function trustedKind(scores: ReaderScores | undefined): boolean {
  const kind = scores?.tasks.mailKind;
  return (
    current(scores) &&
    kind !== undefined &&
    kind.cases >= MIN_KIND_CASES &&
    kind.accuracy >= KIND_BAR
  );
}

/**
 * Whether one kind, when the model names it, is right often enough to act on:
 * a newsletter's dates are set aside only on this, because a bill called a
 * newsletter would lose its due date. Measured to the bar a date is.
 */
export function trustedMailKind(scores: ReaderScores | undefined, kind: string): boolean {
  const named = scores?.tasks.mailKind?.byKind?.[kind];
  return (
    current(scores) &&
    named !== undefined &&
    named.offered >= MIN_SAMPLE &&
    named.precision >= PRECISION_BAR
  );
}

/** The kinds of reading a label rule gives, each measured apart. */
export const RULE_KINDS = ["due", "event", "expiry", "amount"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleTally {
  /** Readings of this kind that one reader could be trusted with. */
  offered: number;
  /** Of those: the document states that value under that meaning. */
  right: number;
}

export type RuleScores = Record<RuleKind, RuleTally>;

/**
 * What the label rules measure (eval/rulescore.ts): on the first set, on
 * the held-out set, on a held-out batch of bills and notices, and on a
 * held-out batch of bills that arrive by mail. The three held-out parts are
 * one measure of documents never seen.
 */
export interface RuleRecord {
  first: RuleScores;
  heldout: RuleScores;
  fresh: RuleScores;
  mail: RuleScores;
}

/** The record measured for the label rules this build ships. */
export function ruleScores(): RuleRecord {
  return shippedRules as RuleRecord;
}

/**
 * The kinds of label reading that are right often enough to count on the
 * rule's word: the bar every reader has, on the first set and on the unseen
 * documents together. An amount is a bill's, so it is trusted only where the
 * day to pay is. A record that lacks a part trusts nothing.
 */
export function trustedKinds(record: RuleRecord | undefined): RuleKind[] {
  if (!record?.first || !record.heldout || !record.fresh || !record.mail) {
    return [];
  }
  const clears = (tally: RuleTally | undefined) =>
    tally !== undefined && tally.offered >= MIN_SAMPLE && tally.right / tally.offered >= PRECISION_BAR;
  const unseen = (kind: RuleKind): RuleTally | undefined => {
    const parts = [record.heldout[kind], record.fresh[kind], record.mail[kind]];
    if (parts.some((part) => part === undefined)) {
      return undefined;
    }
    return { offered: parts.reduce((sum, part) => sum + part.offered, 0), right: parts.reduce((sum, part) => sum + part.right, 0) };
  };
  const cleared = RULE_KINDS.filter((kind) => clears(record.first[kind]) && clears(unseen(kind)));
  return cleared.filter((kind) => kind !== "amount" || cleared.includes("due"));
}

/** A reading one reader could be trusted with at all: not a date of doubt, not where a wrong value costs much, and sane. */
export function withoutDoubt(fact: Fact, siblings: readonly Fact[], now: number): boolean {
  return !fact.relative && !fact.assumedYear && !fact.ambiguous && stakesOf(fact) !== "high" && saneFact(fact, siblings, now);
}

/** The longest a day to pay may lie ahead of its document and still be plain. */
const PLAIN_DAYS_AHEAD = 366;

/** A label whose own words say the day is due or to pay. */
const SAYS_DUE = /\b(?:dues?|pay|paid|payable|payments?|repayments?|owing|remit)\b/i;
/** A renewal's label says when a plan or a cover renews; the money may leave on another day. */
const SAYS_RENEWAL = /\brenew/i;

/**
 * Whether the label a day was read under itself says "due" or "pay". The
 * word rule for "due date" and "pay by" states no label of its own. Every
 * other label a day to act by is read under (a renewal, "return by",
 * "confirm by", "will be charged on", a direct debit, a disconnection)
 * names another matter, and that day still asks.
 */
function saysDue(fact: Fact): boolean {
  return fact.label === undefined || (SAYS_DUE.test(fact.label) && !SAYS_RENEWAL.test(fact.label));
}

/**
 * Whether a label rule's reading of a day to pay leaves no room for doubt:
 * the document states the day it was written (a mail's sending day), the
 * label itself says due or pay and its date stands straight after it, the
 * reading is the only day to pay the rules read in the mail, it is not
 * behind the sending day and lies within a year of it, the text prints it
 * whole, and a wrong value would not cost much. Only a plain reading is
 * measured (eval/rulescore.ts), and only a plain reading can count on the
 * rule's word. A stored file states no day of its own: the day it was kept
 * says nothing about a day printed in it, so none of its readings is plain.
 */
export function plainDue(fact: Fact, siblings: readonly Fact[], written: number | undefined): boolean {
  if (fact.kind !== "due" || fact.source !== "label" || written === undefined || !withoutDoubt(fact, siblings, written)) {
    return false;
  }
  if (fact.apart || !saysDue(fact)) {
    return false;
  }
  // A second day to pay (an instalment, a final notice) is a choice to make.
  if (siblings.some((other) => other.kind === "due" && other.source === "label" && other.value !== fact.value)) {
    return false;
  }
  // Counted on one ruler, so the answer is the same in every time zone.
  const ahead = Math.round((Date.parse(`${fact.value}T00:00:00Z`) - Math.floor(written / DAY) * DAY) / DAY);
  return ahead >= 0 && ahead <= PLAIN_DAYS_AHEAD;
}

/**
 * Whether an amount is the one a bill asks for, on a bill whose day to pay
 * is plain: its amount due, else its one total, as a label rule read it.
 */
export function plainAmount(fact: Fact, siblings: readonly Fact[], written: number | undefined): boolean {
  if (fact.kind !== "amount" || fact.source !== "label" || written === undefined) {
    return false;
  }
  if (!siblings.some((other) => plainDue(other, siblings, written))) {
    return false;
  }
  const stated = siblings.filter((other) => other.kind === "amount" && other.source === "label" && other.unit);
  return billAmountOf(stated)?.id === fact.id && saneFact(fact, siblings, written);
}

/** Whether a reading counts without a yes, and on what basis; null while it must ask. */
export function acceptance(
  fact: Fact,
  ctx: {
    scores: ReaderScores | undefined;
    /** The label rules' measured record; a label reading counts only on it. */
    rules?: RuleRecord;
    /** The file's facts, the one judged among them. */
    siblings: readonly Fact[];
    now: number;
    /** The day the document itself states it was written: a mail's sending day. A stored file has none. */
    written?: number;
  },
): "exact" | "grounded" | null {
  if (fact.confidence === 1 && fact.source !== "user" && EXACT_SOURCES.has(fact.source)) {
    return "exact";
  }
  // A label rule's reading counts on the rule's word only where it is plain
  // and that kind of reading is measured right: a day to pay, and with it
  // the amount the bill asks for. A reading another reader disputes is a
  // question. An event or an expiry by label always waits for a yes.
  if (fact.source === "label") {
    if (fact.disputed) {
      return null;
    }
    const trusted = trustedKinds(ctx.rules);
    if (fact.kind === "due") {
      return trusted.includes("due") && plainDue(fact, ctx.siblings, ctx.written) ? "grounded" : null;
    }
    if (fact.kind === "amount") {
      return trusted.includes("amount") && plainAmount(fact, ctx.siblings, ctx.written) ? "grounded" : null;
    }
    return null;
  }
  // A day said in words, or a year the text left out, is the reader's
  // inference from when the message was sent: never settled without a yes.
  if (fact.relative || fact.assumedYear) {
    return null;
  }
  // Scores measured for another version of the reader, or another prompt,
  // say nothing about this one.
  if (fact.source !== "model" || !current(ctx.scores) || stakesOf(fact) === "high") {
    return null;
  }
  // The first set is the one the instructions were written against; the
  // held-out set says whether that carries to documents never seen. Both.
  const task = fact.kind === "amount" ? "amounts" : "dates";
  const clears = (score: TaskScore | undefined) =>
    score !== undefined && score.offered >= MIN_SAMPLE && score.precision >= PRECISION_BAR;
  if (!clears(ctx.scores.tasks[task]) || !clears(ctx.scores.heldout?.tasks[task])) {
    return null;
  }
  return saneFact(fact, ctx.siblings, ctx.now) ? "grounded" : null;
}
