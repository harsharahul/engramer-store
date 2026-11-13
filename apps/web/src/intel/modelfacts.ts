/**
 * What the on-device assistant's readings share with the facts pipeline:
 * the kinds of document it may name, and how much its word is worth.
 *
 * The assistant names a document's kind while it reads it for its summary.
 * It does not write dates or amounts: rules find those (candidates.ts) and
 * the assistant only says what each one is (judge.ts). What comes of that
 * enters the pipeline at its weakest tier and is offered for confirmation.
 * Nothing here acts on anything.
 */

import type { JsonSchemaProperty } from "./assistant";
import type { DocumentKind } from "./facts";

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

/** Below every rule-based tier, above nothing: a model's reading is a lead. */
export const MODEL_CONFIDENCE = 0.45;

type EnumProperty = Extract<JsonSchemaProperty, { type: "string" | "number" | "integer" | "boolean" }>;

/** The property a reading's schema gains when date reading is on: what kind of document this is. */
export const documentKindProperty: { document: EnumProperty } = {
  document: {
    type: "string",
    enum: [...DOCUMENT_KINDS],
    description: "What kind of document this is, from the list; other when unsure",
  },
};
