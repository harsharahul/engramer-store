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

import { EXACT_SOURCES, type Fact } from "./facts";
import { READER_VERSION } from "./reading";
import { ruleAcceptance, type RuleRecord } from "./rulerecord";
import { MIN_SAMPLE, PRECISION_BAR, saneFact, stakesOf } from "./stakes";
import { readingFingerprint } from "./summarize";
import shipped from "./eval/scores.json";

// The checks every reader shares, and the label rules' own record, live in
// modules that import no reader's machinery; they are part of this one's face.
export * from "./rulerecord";
export * from "./stakes";

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
  // A label rule's reading counts on the rule's own word only where it is
  // plain and that kind of reading is measured right (rulerecord.ts).
  if (fact.source === "label") {
    return ruleAcceptance(fact, { rules: ctx.rules, siblings: ctx.siblings, ...(ctx.written !== undefined ? { written: ctx.written } : {}) });
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
