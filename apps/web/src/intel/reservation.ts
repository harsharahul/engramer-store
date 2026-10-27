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

import { isRealDate } from "./dates";
import { factId, type DocumentKind, type Fact } from "./facts";

const SCRIPT_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

const RESERVATION_TYPE =
  /(?:^|[^A-Za-z])(?:Flight|Lodging|RentalCar|Train|Bus|Boat|Event|FoodEstablishment)Reservation$/;

/** Structured data a bill or a shipping notice carries about itself. */
const BILLING_TYPE = /(?:^|[^A-Za-z])(?:Invoice|ParcelDelivery)$/;

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

/** Every object of a matching type in a parsed block, arrays and graphs included. */
function nodesIn(node: unknown, pattern: RegExp, out: Node[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      nodesIn(item, pattern, out);
    }
    return;
  }
  const obj = record(node);
  if (!obj) {
    return;
  }
  const type = str(obj["@type"]);
  if (type && pattern.test(type)) {
    out.push(obj);
  }
  if (obj["@graph"]) {
    nodesIn(obj["@graph"], pattern, out);
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
  // A day that does not exist, or a clock past 23:59, is not a reading.
  if (!match || !isRealDate(match[1]!) || (match[2] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(match[2]))) {
    return null;
  }
  return {
    value: match[1]!,
    ...(match[2] ? { time: match[2] } : {}),
    ...(match[3] ? { zone: match[3] === "Z" ? "UTC" : match[3] } : {}),
  };
}

function factsOf(res: Node): Fact[] {
  // "http://schema.org/FlightReservation" and "FlightReservation" alike.
  const type = (str(res["@type"]) ?? "").replace(/^.*[:/]/, "");
  const document: DocumentKind = type.startsWith("Lodging")
    ? "hotel-booking"
    : type.startsWith("RentalCar")
      ? "car-rental"
      : type.startsWith("EventReservation")
        ? "event-ticket"
        : type.startsWith("FoodEstablishment")
          ? "dining"
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
  } else if (type.startsWith("Bus") || type.startsWith("Boat")) {
    const bus = type.startsWith("Bus");
    const provider = str(record(target?.["provider"])?.["name"]) ?? "";
    const from = str(record(target?.[bus ? "departureBusStop" : "departureBoatTerminal"])?.["name"]) ?? "";
    const to = str(record(target?.[bus ? "arrivalBusStop" : "arrivalBoatTerminal"])?.["name"]) ?? "";
    const trip = [bus ? "Bus" : "Boat", provider].filter(Boolean).join(" ");
    event(target?.["departureTime"] ?? res["departureTime"], `${trip} departs ${from}`.trim());
    event(target?.["arrivalTime"] ?? res["arrivalTime"], `${trip} arrives ${to}`.trim());
  } else if (type.startsWith("EventReservation")) {
    const name = str(target?.["name"]) ?? "the event";
    event(target?.["startDate"] ?? res["startTime"], name);
    event(target?.["endDate"] ?? res["endTime"], `${name} ends`);
  } else if (type.startsWith("FoodEstablishment")) {
    const name = str(target?.["name"]) ?? "the restaurant";
    event(res["startTime"] ?? target?.["startDate"], `Table at ${name}`);
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

/** A bill's due date, amount and number, or a parcel's delivery window. */
function billingFactsOf(node: Node): Fact[] {
  const type = (str(node["@type"]) ?? "").replace(/^.*[:/]/, "");
  const invoice = type === "Invoice";
  const document: DocumentKind = invoice ? "invoice" : "delivery";
  const facts: Fact[] = [];
  const dated = (kind: "due" | "event", stamp: unknown, label: string) => {
    const at = when(stamp);
    if (!at) {
      return;
    }
    facts.push({
      id: factId(kind, kind === "event" ? `${at.value} ${label.toLowerCase()}` : at.value),
      kind,
      document,
      value: at.value,
      ...(at.time ? { time: at.time } : {}),
      ...(at.zone ? { zone: at.zone } : {}),
      label,
      source: "jsonld",
      confidence: 1,
    });
  };
  const identifier = (value: string | undefined, label: string) => {
    if (value) {
      facts.push({
        id: factId("identifier", value),
        kind: "identifier",
        document,
        value,
        label,
        source: "jsonld",
        confidence: 1,
      });
    }
  };
  if (invoice) {
    dated("due", node["paymentDueDate"] ?? node["paymentDue"], "Payment due");
    const total = record(node["totalPaymentDue"]);
    const price = Number(String(total?.["price"] ?? total?.["value"] ?? "").replace(/,/g, ""));
    const currency = str(total?.["priceCurrency"]) ?? str(total?.["currency"]);
    if (Number.isFinite(price) && price > 0 && currency) {
      const value = price.toFixed(2);
      facts.push({
        id: factId("amount", value),
        kind: "amount",
        document,
        value,
        unit: currency.toUpperCase(),
        label: "Amount due",
        source: "jsonld",
        confidence: 1,
      });
    }
    identifier(str(node["confirmationNumber"]) ?? str(node["identifier"]), "Invoice number");
    identifier(str(node["accountId"]), "Account number");
  } else {
    dated("event", node["expectedArrivalFrom"], "Delivery window opens");
    dated("event", node["expectedArrivalUntil"], "Delivery expected by");
    identifier(str(node["trackingNumber"]), "Tracking number");
  }
  return facts;
}

/** The first statement of each fact wins: the same data often appears in
 * both the html and text parts of a saved email. */
function firstOfEach(facts: Iterable<Fact>): Fact[] {
  const byId = new Map<string, Fact>();
  for (const fact of facts) {
    if (!byId.has(fact.id)) {
      byId.set(fact.id, fact);
    }
  }
  return [...byId.values()];
}

/** Everything the document's own reservation data states, or nothing. */
export function reservationFacts(raw: string): Fact[] {
  const found: Node[] = [];
  for (const block of jsonBlocks(raw)) {
    nodesIn(block, RESERVATION_TYPE, found);
  }
  return firstOfEach(found.flatMap(factsOf));
}

/** Reservations, bills and deliveries a document states about itself. */
export function structuredDataFacts(raw: string): Fact[] {
  const reservations: Node[] = [];
  const billing: Node[] = [];
  for (const block of jsonBlocks(raw)) {
    nodesIn(block, RESERVATION_TYPE, reservations);
    nodesIn(block, BILLING_TYPE, billing);
  }
  return firstOfEach([...reservations.flatMap(factsOf), ...billing.flatMap(billingFactsOf)]);
}
