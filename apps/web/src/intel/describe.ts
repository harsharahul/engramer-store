/**
 * Facts in the words a person would use.
 *
 * Kept apart from the components that render them so the sentences can be
 * tested directly. The two mistakes worth guarding against are both grammar:
 * "a invoice" and "1 document carry" read as generated text rather than
 * written text, and they do it in the part of the product that speaks with
 * the most authority.
 */

import type { Fact } from "./facts";
import { daysUntil } from "./dates";

const DOCUMENT_LABELS: Record<string, string> = {
  passport: "passport",
  "drivers-license": "driver's licence",
  "id-card": "identity card",
  visa: "visa",
  "residence-permit": "residence permit",
  insurance: "insurance policy",
  warranty: "warranty",
  membership: "membership",
  "vehicle-registration": "vehicle registration",
  certification: "certificate",
  invoice: "invoice",
  "boarding-pass": "boarding pass",
  "hotel-booking": "hotel booking",
  itinerary: "itinerary",
  "car-rental": "car rental",
  "event-ticket": "ticket",
  other: "document",
};

const KIND_VERBS: Record<string, string> = {
  expiry: "expiring",
  due: "due",
  issued: "issued",
  event: "on",
  period: "running to",
};

/** Where a fact came from, said plainly enough to judge how much to trust it. */
const SOURCE_LABELS: Record<string, string> = {
  barcode: "read from the barcode",
  mrz: "read from the machine-readable zone",
  label: "labelled in the document",
  pattern: "found in the text",
  model: "proposed and checked against the document",
  user: "entered by you",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A date as a person writes it, not as a machine stores it. */
export function shown(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return parts ? `${Number(parts[3])} ${MONTHS[Number(parts[2]) - 1]} ${parts[1]}` : iso;
}

/** "an invoice", not "a invoice". */
export function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

export function documentLabel(document: string): string {
  return DOCUMENT_LABELS[document] ?? "document";
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * "insurance policy expiring 30 April 2027", or, for a label the system does
 * not know, the document's own words: "“Benefit End Date”: 19 October 2027".
 * The quotes are the honesty: the system is repeating, not interpreting.
 */
export function describeFact(fact: Fact): string {
  const at = fact.time ? ` at ${fact.time}` : "";
  if (fact.kind === "dated" && fact.label) {
    return `“${fact.label}”: ${shown(fact.value)}${at}`;
  }
  return `${documentLabel(fact.document)} ${KIND_VERBS[fact.kind] ?? "dated"} ${shown(
    fact.value,
  )}${at}`;
}

/** How far away, in the words someone would say out loud. */
export function whenLabel(iso: string, now: number): string {
  const days = daysUntil(iso, now);
  if (days < -1) {
    return `${-days} days ago`;
  }
  if (days === -1) {
    return "yesterday";
  }
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "tomorrow";
  }
  if (days < 45) {
    return `in ${days} days`;
  }
  // Days up to 45, so the months branch never has to say "in 1 months": the
  // smallest it can produce is two. Months stop short of a year for the same
  // reason in reverse, since "in 12 months" is a worse way to say "in a year".
  if (days < 350) {
    return `in ${Math.round(days / 30)} months`;
  }
  const years = Math.round(days / 365);
  return years === 1 ? "in a year" : `in ${years} years`;
}
