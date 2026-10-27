/**
 * When a reading counts without the owner's yes.
 *
 * Confidence is computed, never the model's own report: an exact source
 * counts as read; agreement between two readers is decided where readings
 * merge (facts.ts); a model reading alone counts only for a task where the
 * reader's precision, measured on the eval set over enough readings and for
 * this version of the reader, is at least 98%, only when the stakes allow
 * one reader, and only when the value passes the sanity checks. Everything
 * else waits for a yes.
 */

import { isRealDate } from "./dates";
import { EXACT_SOURCES, type Fact } from "./facts";
import { READER_VERSION } from "./reading";
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
  tasks: {
    dates?: TaskScore;
    amounts?: TaskScore;
    mailKind?: { accuracy: number; cases: number; byKind?: Record<string, { precision: number; offered: number }> };
  };
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
  if (fact.kind === "event" && TRAVEL_TIME.test(label)) {
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
  if (/check-?out/i.test(fact.label ?? "")) {
    const place = (fact.label ?? "").replace(/^.*?:\s*/, "").toLowerCase();
    const checkin = siblings.find(
      (other) => /check-?in/i.test(other.label ?? "") && (other.label ?? "").toLowerCase().includes(place),
    );
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

/** Whether the model's naming of an email's kind is stored as a tag. */
export function trustedKind(scores: ReaderScores | undefined): boolean {
  const kind = scores?.tasks.mailKind;
  return (
    scores !== undefined &&
    kind !== undefined &&
    scores.version === READER_VERSION[scores.reader] &&
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
    scores !== undefined &&
    named !== undefined &&
    scores.version === READER_VERSION[scores.reader] &&
    named.offered >= MIN_SAMPLE &&
    named.precision >= PRECISION_BAR
  );
}

/** Whether a reading counts without a yes, and on what basis; null while it must ask. */
export function acceptance(
  fact: Fact,
  ctx: { scores: ReaderScores | undefined; siblings: readonly Fact[]; now: number },
): "exact" | "grounded" | null {
  if (fact.confidence === 1 && fact.source !== "user" && EXACT_SOURCES.has(fact.source)) {
    return "exact";
  }
  if (fact.source !== "model" || !ctx.scores || stakesOf(fact) === "high") {
    return null;
  }
  // Scores measured for another version of the reader say nothing about this one.
  if (ctx.scores.version !== READER_VERSION[ctx.scores.reader]) {
    return null;
  }
  const score = ctx.scores.tasks[fact.kind === "amount" ? "amounts" : "dates"];
  if (!score || score.offered < MIN_SAMPLE || score.precision < PRECISION_BAR) {
    return null;
  }
  return saneFact(fact, ctx.siblings, ctx.now) ? "grounded" : null;
}
