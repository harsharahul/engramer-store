/**
 * What any reading must pass before one reader's word is enough: the
 * measured bar, the cost of a wrong value, and the sanity of the value.
 *
 * Kept free of every reader's machinery, so the label rules (scan.ts) and
 * the model's path (confidence.ts) judge with the same checks.
 */

import { isRealDate } from "./dates";
import type { Fact } from "./facts";
import { subjectOf } from "./subject";

export type Stakes = "high" | "normal" | "low";

/** Measured precision this high, or a reading is not trusted alone. */
export const PRECISION_BAR = 0.98;
/** Readings a precision must rest on before it means anything. */
export const MIN_SAMPLE = 30;

const IDENTITY_DOCUMENTS = new Set(["passport", "visa", "residence-permit", "id-card", "drivers-license"]);
const TRAVEL_TIME = /\b(?:depart|departs|arrive|arrives|flight|boarding)\b/i;
const LEGAL = /\b(?:deadline|court|filing|hearing)\b/i;
const YEARS = 20;
export const DAY = 86_400_000;

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
