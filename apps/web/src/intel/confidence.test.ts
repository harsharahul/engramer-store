import { describe, expect, it } from "vitest";
import type { Fact } from "./facts";
import { acceptance, MIN_SAMPLE, saneFact, stakesOf, type ReaderScores } from "./confidence";

const NOW = Date.UTC(2027, 2, 1);

const fact = (over: Partial<Fact>): Fact => ({
  id: "x",
  kind: "due",
  document: "invoice",
  value: "2027-04-10",
  label: "Payment due",
  source: "model",
  confidence: 0.45,
  ...over,
});

const scores = (dates: { precision: number; offered: number }, version = 1): ReaderScores => ({
  reader: "apple",
  version,
  tasks: { dates: { ...dates, recall: 0.5, expected: 40 }, amounts: { precision: 1, recall: 0.3, offered: 3, expected: 10 } },
});

const trusted = scores({ precision: 0.99, offered: MIN_SAMPLE + 10 });

describe("acceptance", () => {
  it("a grounded bill due date is accepted where the measured precision allows it", () => {
    expect(acceptance(fact({}), { scores: trusted, siblings: [], now: NOW })).toBe("grounded");
  });

  it("the same date stays offered when the task measured below 98%", () => {
    expect(acceptance(fact({}), { scores: scores({ precision: 0.69, offered: 40 }), siblings: [], now: NOW })).toBeNull();
  });

  it("a precision measured over too few readings is not trusted", () => {
    // Amounts measured 100% over three readings.
    const amount = fact({ id: "amount:65.00", kind: "amount", value: "65.00", unit: "USD", label: "Amount due" });
    expect(acceptance(amount, { scores: trusted, siblings: [], now: NOW })).toBeNull();
  });

  it("scores measured for another version of the reader are not trusted", () => {
    expect(acceptance(fact({}), { scores: scores({ precision: 0.99, offered: 80 }, 0), siblings: [], now: NOW })).toBeNull();
  });

  it("a departure time from the model alone is never accepted", () => {
    const departure = fact({ kind: "event", document: "itinerary", label: "Flight AQ 214 departs SFO", time: "09:40" });
    expect(stakesOf(departure)).toBe("high");
    expect(acceptance(departure, { scores: trusted, siblings: [], now: NOW })).toBeNull();
  });

  it("a stay whose check-out precedes check-in is offered, not accepted", () => {
    const checkin = fact({ id: "in", kind: "event", document: "hotel-booking", value: "2027-04-12", label: "Check-in: Casa do Rio" });
    const checkout = fact({ id: "out", kind: "event", document: "hotel-booking", value: "2027-04-08", label: "Check-out: Casa do Rio" });
    expect(saneFact(checkout, [checkin], NOW)).toBe(false);
    expect(acceptance(checkout, { scores: trusted, siblings: [checkin], now: NOW })).toBeNull();
  });

  it("exact readings are accepted whatever the scores say", () => {
    expect(acceptance(fact({ source: "jsonld", confidence: 1 }), { scores: undefined, siblings: [], now: NOW })).toBe("exact");
  });
});

describe("stakesOf", () => {
  it("weighs identity expiries and travel times high, bills normal, receipts and deliveries low", () => {
    expect(stakesOf(fact({ kind: "expiry", document: "passport" }))).toBe("high");
    expect(stakesOf(fact({ kind: "due" }))).toBe("normal");
    expect(stakesOf(fact({ kind: "amount", label: "Total" }))).toBe("low");
    expect(stakesOf(fact({ kind: "event", document: "delivery", label: "Delivery expected by" }))).toBe("low");
  });
});

describe("saneFact", () => {
  it("refuses a date that does not exist or lies far outside a lifetime of documents", () => {
    expect(saneFact(fact({ value: "2027-02-31" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ value: "2091-01-01" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ kind: "amount", value: "65.00", label: "Amount due" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ kind: "amount", value: "65.00", unit: "USD", label: "Amount due" }), [], NOW)).toBe(true);
  });
});
