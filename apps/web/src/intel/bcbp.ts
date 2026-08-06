/**
 * Reading the boarding pass barcode: IATA BCBP, the exact half of travel.
 *
 * Two limits shape everything here. The date is a Julian day of year with no
 * year on it, so the year is inferred from when the document was stored, and
 * the flight is offered below structured confidence rather than asserted.
 * And there is no departure time in the barcode at all: the printed text
 * carries that, and the two sources check each other downstream.
 *
 * Same discipline as the licence and passport readers: fixed positions,
 * validation of every field this parser relies on, one failure discards the
 * whole read. Fixtures are synthesized; no real pass is stored anywhere.
 */

import { factId, type Fact } from "./facts";

export interface BcbpLeg {
  pnr: string;
  from: string;
  to: string;
  carrier: string;
  flight: string;
  julian: number;
}

/** The mandatory items of one leg occupy exactly this many characters. */
const MANDATORY_CHARS = 60;

/** The mandatory items of the first leg, or null when anything disagrees. */
export function bcbpLeg(payload: string): BcbpLeg | null {
  if (payload.length < MANDATORY_CHARS || payload[0] !== "M") {
    return null;
  }
  if (!/^[1-9]$/.test(payload[1]!)) {
    return null;
  }
  // Passenger name, surname/given. Read only to validate the shape; a name
  // is not a fact this reader has any business storing.
  if (!payload.slice(2, 22).includes("/")) {
    return null;
  }
  const pnr = payload.slice(23, 30).trim();
  const from = payload.slice(30, 33);
  const to = payload.slice(33, 36);
  const carrier = payload.slice(36, 39).trim();
  const flightRaw = payload.slice(39, 44).trim();
  const julian = Number(payload.slice(44, 47));
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return null;
  }
  if (!/^[A-Z0-9]{2,3}$/.test(carrier) || !/^\d+[A-Z]?$/.test(flightRaw)) {
    return null;
  }
  if (!Number.isInteger(julian) || julian < 1 || julian > 366) {
    return null;
  }
  if (pnr.length < 5 || !/^[A-Z0-9]+$/.test(pnr)) {
    return null;
  }
  const flight = flightRaw.replace(/^0+(?=\d)/, "");
  return { pnr, from, to, carrier, flight, julian };
}

function isoOf(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * The flight as an event and the booking reference as an identifier, or
 * nothing at all. The year is whichever candidate puts the flight closest to
 * the day the pass was stored, which is nearly always within months of it.
 */
export function bcbpFacts(payload: string, storedAt: number): Fact[] {
  const leg = bcbpLeg(payload);
  if (!leg) {
    return [];
  }
  const storedYear = new Date(storedAt).getUTCFullYear();
  let best = { iso: "", gap: Number.POSITIVE_INFINITY };
  for (const year of [storedYear - 1, storedYear, storedYear + 1]) {
    const at = Date.UTC(year, 0, leg.julian);
    const gap = Math.abs(at - storedAt);
    if (gap < best.gap) {
      best = { iso: isoOf(at), gap };
    }
  }
  const flight = `Flight ${leg.carrier} ${leg.flight} ${leg.from} to ${leg.to}`;
  return [
    {
      id: factId("event", `${best.iso} ${leg.carrier}${leg.flight}`),
      kind: "event",
      document: "boarding-pass",
      value: best.iso,
      label: flight,
      source: "barcode",
      confidence: 0.6,
    },
    {
      id: factId("identifier", leg.pnr),
      kind: "identifier",
      document: "boarding-pass",
      value: leg.pnr,
      label: "Booking reference",
      source: "barcode",
      confidence: 1,
    },
  ];
}
