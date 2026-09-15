/**
 * Dates and amounts the on-device assistant proposes while it reads a
 * document for its summary. The proposals arrive in the same reading, so
 * a document costs one model call, and they enter the facts pipeline at
 * its weakest tier: typed by this module, then grounded against the
 * document's own text (a value the text does not state, in some rendering,
 * is dropped, never lowered in confidence), then merged like every other
 * reading and offered for confirmation. Nothing here acts on anything.
 */

import { factId, groundFacts, type DocumentKind, type Fact, type FactKind } from "./facts";
import type { JsonSchemaProperty } from "./assistant";

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
  "other",
];

/** The kinds a model may propose: the dated ones and amounts. Identifiers
 * are never asked for; a reference number does not belong in a proposal. */
const PROPOSABLE_KINDS: readonly FactKind[] = ["expiry", "due", "issued", "event", "amount"];

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
      },
      required: ["kind", "label", "value"],
      order: ["kind", "label", "value", "time"],
    },
  },
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\d+(?:\.\d{1,2})?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(value: string): boolean {
  const match = ISO.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

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
    typed.push({
      id,
      kind: kind as FactKind,
      document,
      value,
      ...(label ? { label } : {}),
      ...(time ? { time } : {}),
      source: "model",
      confidence: MODEL_CONFIDENCE,
    });
    if (typed.length === MAX_PROPOSALS) {
      break;
    }
  }
  return groundFacts(typed, text);
}
