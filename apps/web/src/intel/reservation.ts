/**
 * Reading the reservation a saved confirmation states about itself.
 *
 * Airlines, hotels and rental agencies embed schema.org JSON-LD in their
 * confirmation emails so mail clients can assemble trips; someone who saves
 * that email or page has stored an entire reservation as structured data.
 * This is tier-0 travel: the document speaking, not a pattern guessing, so
 * facts leave here at full confidence and are exempt from prose grounding
 * the same way barcodes are. Malformed JSON simply fails to parse and
 * contributes nothing, which is the integrity check.
 *
 * Times are kept as the reservation wrote them: local date and clock apart,
 * with the printed offset carried only when the timestamp had one. Nothing
 * here converts a time between zones.
 */

import { factId, type DocumentKind, type Fact } from "./facts";

const SCRIPT_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

const RESERVATION_TYPE = /(?:Flight|Lodging|RentalCar|Train)Reservation$/;

type Node = Record<string, unknown>;

function record(value: unknown): Node | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonBlocks(raw: string): unknown[] {
  const blocks: unknown[] = [];
  SCRIPT_BLOCK.lastIndex = 0;
  for (let match = SCRIPT_BLOCK.exec(raw); match; match = SCRIPT_BLOCK.exec(raw)) {
    try {
      blocks.push(JSON.parse(match[1]!));
    } catch {
      // Half a document is not data.
    }
  }
  if (blocks.length === 0 && raw.includes('"@type"')) {
    // A saved email can carry the JSON-LD part bare, outside any markup.
    try {
      blocks.push(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    } catch {
      // Then it was not that either.
    }
  }
  return blocks;
}

/** Every reservation object in a parsed block, arrays and graphs included. */
function reservationsIn(node: unknown, out: Node[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      reservationsIn(item, out);
    }
    return;
  }
  const obj = record(node);
  if (!obj) {
    return;
  }
  const type = str(obj["@type"]);
  if (type && RESERVATION_TYPE.test(type)) {
    out.push(obj);
  }
  if (obj["@graph"]) {
    reservationsIn(obj["@graph"], out);
  }
}

const STAMP = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?/;

/** A timestamp split the way facts store it: date, clock, printed offset. */
function when(stamp: unknown): { value: string; time?: string; zone?: string } | null {
  const text = str(stamp);
  if (!text) {
    return null;
  }
  const match = STAMP.exec(text);
  if (!match) {
    return null;
  }
  return {
    value: match[1]!,
    ...(match[2] ? { time: match[2] } : {}),
    ...(match[3] ? { zone: match[3] === "Z" ? "UTC" : match[3] } : {}),
  };
}

function factsOf(res: Node): Fact[] {
  const type = str(res["@type"]) ?? "";
  const document: DocumentKind = type.startsWith("Lodging")
    ? "hotel-booking"
    : type.startsWith("RentalCar")
      ? "car-rental"
      : "itinerary";
  const target = record(res["reservationFor"]);
  const facts: Fact[] = [];

  const event = (stamp: unknown, label: string): void => {
    const at = when(stamp);
    if (!at || !label.trim()) {
      return;
    }
    facts.push({
      id: factId("event", `${at.value} ${label.toLowerCase()}`),
      kind: "event",
      document,
      value: at.value,
      ...(at.time ? { time: at.time } : {}),
      ...(at.zone ? { zone: at.zone } : {}),
      label,
      source: "jsonld",
      confidence: 1,
    });
  };

  if (type.startsWith("Flight")) {
    const airline = record(target?.["airline"]) ?? record(target?.["provider"]);
    const carrier = str(airline?.["iataCode"]) ?? str(airline?.["name"]) ?? "";
    const number = str(target?.["flightNumber"]) ?? "";
    const from = record(target?.["departureAirport"]);
    const to = record(target?.["arrivalAirport"]);
    const fromName = str(from?.["iataCode"]) ?? str(from?.["name"]) ?? "";
    const toName = str(to?.["iataCode"]) ?? str(to?.["name"]) ?? "";
    const flight = ["Flight", carrier, number].filter(Boolean).join(" ");
    event(target?.["departureTime"], `${flight} departs ${fromName}`.trim());
    event(target?.["arrivalTime"], `${flight} arrives ${toName}`.trim());
  } else if (type.startsWith("Lodging")) {
    const name = str(target?.["name"]) ?? "the stay";
    event(res["checkinTime"], `Check-in: ${name}`);
    event(res["checkoutTime"], `Check-out: ${name}`);
  } else if (type.startsWith("RentalCar")) {
    const name =
      str(record(res["pickupLocation"])?.["name"]) ?? str(target?.["name"]) ?? "the rental";
    event(res["pickupTime"], `Pick-up: ${name}`);
    event(res["dropoffTime"], `Drop-off: ${name}`);
  } else if (type.startsWith("Train")) {
    const number = str(target?.["trainNumber"]) ?? "";
    const station = str(record(target?.["departureStation"])?.["name"]) ?? "";
    const train = ["Train", number].filter(Boolean).join(" ");
    event(target?.["departureTime"], `${train} departs ${station}`.trim());
    event(target?.["arrivalTime"], `${train} arrives`.trim());
  }

  const reference = str(res["reservationNumber"]);
  if (reference) {
    facts.push({
      id: factId("identifier", reference),
      kind: "identifier",
      document,
      value: reference,
      label: "Confirmation number",
      source: "jsonld",
      confidence: 1,
    });
  }
  return facts;
}

/** Everything the document's own reservation data states, or nothing. */
export function reservationFacts(raw: string): Fact[] {
  const found: Node[] = [];
  for (const block of jsonBlocks(raw)) {
    reservationsIn(block, found);
  }
  // The same reservation often appears in both the html and text parts of a
  // saved email; the first statement of a fact wins.
  const byId = new Map<string, Fact>();
  for (const res of found) {
    for (const fact of factsOf(res)) {
      if (!byId.has(fact.id)) {
        byId.set(fact.id, fact);
      }
    }
  }
  return [...byId.values()];
}
