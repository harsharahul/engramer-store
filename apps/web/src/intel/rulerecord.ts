/**
 * When a label rule's reading counts on the rule's own word.
 *
 * The rules are deterministic, so their record is measured without a model
 * (eval/rulescore.ts) and kept in eval/rulescores.json. A reading counts
 * only where it is plain, the kind of reading clears the bar every reader
 * has, on the first set and on documents never seen, and nobody disputes
 * it. Today that is one thing: the one day to pay a mail states under a
 * label that says due or pay. Everything else a rule reads waits for a yes.
 */

import { billAmountOf, type Fact } from "./facts";
import { DAY, MIN_SAMPLE, PRECISION_BAR, saneFact, stakesOf } from "./stakes";
import shippedRules from "./eval/rulescores.json";

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

/** The plain-reading rule's own version: raised when what counts as plain changes. */
const PLAIN_RULE = 1;

/**
 * The kinds of reading a label rule may count on its own word under a
 * record: a day to pay and its amount, where trusted (see
 * `ruleAcceptance`). What an event or an expiry measures moves nothing.
 */
export function countedKinds(record: RuleRecord | undefined = ruleScores()): RuleKind[] {
  return trustedKinds(record).filter((kind) => kind === "due" || kind === "amount");
}

/**
 * A name for what the label rules may count on their own word: the kinds
 * the record lets them count and the version of the plain-reading rule. It
 * changes when either does, also when the kinds become none, so a pass that
 * looks at stored mail once per name can give a rule's word where it is
 * new and take it back where it no longer holds.
 */
export function ruleEdition(record: RuleRecord | undefined = ruleScores()): string {
  const counted = countedKinds(record);
  return `${counted.length > 0 ? counted.join("+") : "none"}.${PLAIN_RULE}`;
}

/** A reading one reader could be trusted with at all: not a date of doubt, not where a wrong value costs much, and sane. */
export function withoutDoubt(fact: Fact, siblings: readonly Fact[], now: number): boolean {
  return !fact.relative && !fact.assumedYear && !fact.ambiguous && stakesOf(fact) !== "high" && saneFact(fact, siblings, now);
}

/** The longest a day to pay may lie ahead of its document and still be plain. */
const PLAIN_DAYS_AHEAD = 366;

/**
 * Whether a label rule's reading of a day to pay leaves no room for doubt:
 * the document states the day it was written (a mail's sending day), the
 * reader stated the day outright as a day to pay (`Fact.toPay`: the label
 * itself says due or pay, and the date is the label's own), the reading is
 * the only day to pay the rules read in the mail, it is not behind the
 * sending day and lies within a year of it, the text prints it whole, and
 * a wrong value would not cost much. Only a plain reading is measured
 * (eval/rulescore.ts), and only a plain reading can count on the rule's
 * word. A stored file states no day of its own: the day it was kept says
 * nothing about a day printed in it, so none of its readings is plain.
 */
export function plainDue(fact: Fact, siblings: readonly Fact[], written: number | undefined): boolean {
  if (fact.kind !== "due" || fact.source !== "label" || written === undefined || !withoutDoubt(fact, siblings, written)) {
    return false;
  }
  if (!fact.toPay) {
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

/**
 * Whether a label rule's reading counts on the rule's own word; null while
 * it must ask. It counts only where it is plain and that kind of reading is
 * measured right: a day to pay, and with it the amount the bill asks for.
 * A reading another reader disputes is a question. An event or an expiry by
 * label always waits for a yes.
 */
export function ruleAcceptance(
  fact: Fact,
  ctx: {
    /** The label rules' measured record; with none, nothing counts. */
    rules: RuleRecord | undefined;
    /** The file's facts, the one judged among them. */
    siblings: readonly Fact[];
    /** The day the document itself states it was written: a mail's sending day. A stored file has none. */
    written?: number;
  },
): "grounded" | null {
  if (fact.source !== "label" || fact.disputed) {
    return null;
  }
  // Another reader's day to pay on another day (the mail's own invoice
  // data, most of all) makes this one a question: a rule's word never
  // stands against what another reader states.
  if (
    fact.kind === "due" &&
    ctx.siblings.some((other) => other.kind === "due" && other.source !== "label" && !other.dismissed && other.value !== fact.value)
  ) {
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
