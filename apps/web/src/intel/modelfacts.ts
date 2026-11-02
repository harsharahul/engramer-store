/**
 * Dates and amounts the on-device assistant proposes while it reads a
 * document for its summary. The proposals arrive in the same reading, so
 * a document costs one model call, and they enter the facts pipeline at
 * its weakest tier: typed by this module, then grounded against the
 * document's own text (a value the text does not state, in some rendering,
 * is dropped, never lowered in confidence), then merged like every other
 * reading and offered for confirmation. Nothing here acts on anything.
 */

import { isRealDate } from "./dates";
import { factId, groundFacts, isStated, type DocumentKind, type Fact, type FactKind } from "./facts";
import type { JsonSchemaProperty } from "./assistant";
import { cleanSubject, serviceOf, type Subject } from "./subject";

/** Every document kind the facts vocabulary knows, in its own order. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "passport",
  "drivers-license",
  "id-card",
  "visa",
  "residence-permit",
  "insurance",
  "warranty",
  "membership",
  "vehicle-registration",
  "certification",
  "invoice",
  "boarding-pass",
  "hotel-booking",
  "itinerary",
  "car-rental",
  "event-ticket",
  "delivery",
  "dining",
  "other",
];

/** The kinds a model may propose: the dated ones and amounts. Identifiers
 * are never asked for; a reference number does not belong in a proposal. */
const PROPOSABLE_KINDS: readonly FactKind[] = ["expiry", "due", "issued", "event", "amount"];

/** What the model may say a date is; "other" says nothing. */
const ROLES = ["check-in", "check-out", "depart", "arrive", "start", "end", "other"] as const;
const MODES = ["flight", "train", "bus", "boat"] as const;
/** An airport named by its code: "LIS", or "San Francisco (SFO)". */
const AIRPORT = /^([A-Z]{3})$|\(([A-Z]{3})\)/;

/**
 * What the model says a date is about, keeping only what the document's own
 * text states: a place or number it does not contain is left out, the role
 * and the date stand.
 */
function subjectFrom(proposal: Record<string, unknown>, text: string): Subject | undefined {
  const role = typeof proposal["role"] === "string" ? proposal["role"] : "";
  if (!(ROLES as readonly string[]).includes(role) || role === "other") {
    return undefined;
  }
  const stated = (value: unknown) =>
    typeof value === "string" && value.trim() && isStated(value.trim(), text) ? value.trim() : undefined;
  const place = stated(proposal["place"]);
  // A stop named by its airport code is read in that airport's own time, and
  // is a flight whether or not the model said so.
  const airport = place ? AIRPORT.exec(place) : null;
  const code = airport ? (airport[1] ?? airport[2]) : undefined;
  const journey = role === "depart" || role === "arrive";
  return cleanSubject({
    role,
    mode: proposal["mode"] || (code && journey ? "flight" : undefined),
    ...serviceOf(stated(proposal["number"])),
    ...(code && journey ? { code } : {}),
    place,
  });
}

/** Below every rule-based tier, above nothing: a proposal is a lead. */
export const MODEL_CONFIDENCE = 0.45;
const MAX_PROPOSALS = 6;

type EnumProperty = Extract<JsonSchemaProperty, { type: "string" | "number" | "integer" | "boolean" }>;
type ArrayProperty = Extract<JsonSchemaProperty, { type: "array" }>;

/** The two properties a reading schema gains when facts are wanted. */
export const readingFactsSchema: { document: EnumProperty; facts: ArrayProperty } = {
  document: {
    type: "string",
    enum: [...DOCUMENT_KINDS],
    description: "What kind of document this is, from the list; other when unsure",
  },
  facts: {
    type: "array",
    maxItems: MAX_PROPOSALS,
    description:
      "Dates and amounts the document states about itself, each exactly as printed: an expiry, a due date, an issue date, an event with a time, an amount. Leave empty when it states none.",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...PROPOSABLE_KINDS], description: "expiry, due, issued, event, or amount" },
        label: { type: "string", description: "The document's own words for it, such as Valid until" },
        value: { type: "string", description: "The date as YYYY-MM-DD, or the amount as a plain decimal" },
        time: { type: "string", description: "For an event, the time as HH:MM, otherwise empty" },
        role: { type: "string", enum: [...ROLES], description: "What the date is: check-in, check-out, depart, arrive, start, end, or other" },
        mode: { type: "string", enum: [...MODES, ""], description: "For a departure or arrival: flight, train, bus or boat, otherwise empty" },
        place: { type: "string", description: "The hotel, station, airport or venue exactly as printed, otherwise empty" },
        number: { type: "string", description: "A flight or train number exactly as printed, such as AQ 214, otherwise empty" },
      },
      required: ["kind", "label", "value"],
      order: ["kind", "label", "value", "time", "role", "mode", "place", "number"],
    },
  },
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\d+(?:\.\d{1,2})?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const validDate = isRealDate;

/**
 * Types the model's proposals and grounds them against the text. What
 * survives carries the model's source and a modest confidence, and is
 * unconfirmed: it is offered, never applied.
 */
export function proposedFacts(raw: unknown, text: string): Fact[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const answer = raw as { document?: unknown; facts?: unknown };
  const document: DocumentKind =
    typeof answer.document === "string" && (DOCUMENT_KINDS as readonly string[]).includes(answer.document)
      ? (answer.document as DocumentKind)
      : "other";
  if (!Array.isArray(answer.facts)) {
    return [];
  }
  const typed: Fact[] = [];
  const seen = new Set<string>();
  for (const item of answer.facts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const proposal = item as { kind?: unknown; label?: unknown; value?: unknown; time?: unknown };
    const kind = typeof proposal.kind === "string" ? proposal.kind : "";
    if (!(PROPOSABLE_KINDS as readonly string[]).includes(kind)) {
      continue;
    }
    const value = typeof proposal.value === "string" ? proposal.value.trim() : "";
    if (kind === "amount" ? !AMOUNT.test(value) : !validDate(value)) {
      continue;
    }
    const label = typeof proposal.label === "string" ? proposal.label.trim().slice(0, 60) : "";
    const time = typeof proposal.time === "string" && CLOCK.test(proposal.time.trim()) ? proposal.time.trim() : undefined;
    if (kind === "event" && !label) {
      continue;
    }
    const id = kind === "event" ? factId("event", `${value} ${label.toLowerCase()}${time ? ` ${time}` : ""}`) : factId(kind as FactKind, value);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const subject = kind === "event" ? subjectFrom(item as Record<string, unknown>, text) : undefined;
    typed.push({
      id,
      kind: kind as FactKind,
      document,
      value,
      ...(label ? { label } : {}),
      ...(time ? { time } : {}),
      ...(subject ? { subject } : {}),
      source: "model",
      confidence: MODEL_CONFIDENCE,
    });
    if (typed.length === MAX_PROPOSALS) {
      break;
    }
  }
  return groundFacts(typed, text);
}
