import { describe, expect, it } from "vitest";
import { groundFacts } from "./facts";
import { DOCUMENT_KINDS, MODEL_CONFIDENCE, proposedFacts, readingFactsSchema } from "./modelfacts";

const text =
  "Home insurance policy for the flat. Policy number 77-1234. Coverage from 1 October 2025 to 5 October 2026. Premium due: 30 September 2025, 412.50 EUR.";

describe("readingFactsSchema", () => {
  it("asks for a document kind from the vocabulary and a few typed facts", () => {
    expect(readingFactsSchema.document.enum).toEqual(DOCUMENT_KINDS);
    expect(readingFactsSchema.facts.type).toBe("array");
    expect(readingFactsSchema.facts.maxItems).toBe(6);
    const item = readingFactsSchema.facts.items!;
    expect(item.type).toBe("object");
    expect(Object.keys((item as { properties: object }).properties).sort()).toEqual([
      "kind",
      "label",
      "mode",
      "number",
      "place",
      "role",
      "time",
      "value",
    ]);
  });
});

describe("proposedFacts", () => {
  it("turns the model's proposals into facts with the model's source and a modest confidence", () => {
    const facts = proposedFacts(
      {
        document: "insurance",
        facts: [
          { kind: "expiry", label: "Coverage to", value: "2026-10-05" },
          { kind: "due", label: "Premium due", value: "2025-09-30", time: "" },
          { kind: "amount", label: "Premium", value: "412.50" },
        ],
      },
      text,
    );
    expect(facts.map((f) => [f.kind, f.value, f.document, f.source, f.confidence])).toEqual([
      ["expiry", "2026-10-05", "insurance", "model", MODEL_CONFIDENCE],
      ["due", "2025-09-30", "insurance", "model", MODEL_CONFIDENCE],
      ["amount", "412.50", "insurance", "model", MODEL_CONFIDENCE],
    ]);
    expect(facts[0]!.id).toBe("expiry:2026-10-05");
    expect(facts.every((f) => !f.confirmed && !f.dismissed)).toBe(true);
  });

  it("drops what the document does not say, verbatim", () => {
    const facts = proposedFacts(
      { document: "insurance", facts: [{ kind: "expiry", label: "x", value: "2027-01-01" }, { kind: "due", label: "y", value: "2025-09-30" }] },
      text,
    );
    expect(facts.map((f) => f.value)).toEqual(["2025-09-30"]);
    expect(groundFacts(facts, text)).toHaveLength(1);
  });

  it("refuses shapes the grammar does not know: bad kinds, dates, amounts, times, and a made-up document", () => {
    const facts = proposedFacts(
      {
        document: "spaceship-licence",
        facts: [
          { kind: "birthday", label: "x", value: "2026-10-05" },
          { kind: "expiry", label: "x", value: "5 October 2026" },
          { kind: "expiry", label: "x", value: "2026-13-01" },
          { kind: "amount", label: "x", value: "412,50" },
          { kind: "event", label: "Renewal call", value: "2026-10-05", time: "25:99" },
          { kind: "event", label: "Renewal call", value: "2026-10-05", time: "09:30" },
          "not an object",
        ],
      },
      text + " Renewal call at 09:30 on 5 October 2026.",
    );
    expect(facts.map((f) => [f.kind, f.value, f.time, f.document, f.label])).toEqual([
      ["event", "2026-10-05", undefined, "other", "Renewal call"],
      ["event", "2026-10-05", "09:30", "other", "Renewal call"],
    ]);
  });

  it("caps the count and returns nothing for nonsense", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "expiry", label: "x", value: `2026-10-0${(i % 9) + 1}` }));
    expect(proposedFacts({ document: "other", facts: many }, "2026-10-01 ".repeat(1)).length).toBeLessThanOrEqual(6);
    expect(proposedFacts(null, text)).toEqual([]);
    expect(proposedFacts({ facts: "nope" }, text)).toEqual([]);
  });
});

describe("what the model says a date is", () => {
  const guesthouse =
    "Hi! Your room at Casa Azulejo is confirmed. Check-in Friday 13 November 2026 from 15:00, check-out Monday 16 November 2026 by 11:00. Your train IC 521 arrives at Santa Apolonia at 14:10 on 13 November.";

  it("a model reading of a guesthouse email gives check-in and check-out with the place", () => {
    const facts = proposedFacts(
      {
        document: "hotel-booking",
        facts: [
          { kind: "event", label: "Check-in", value: "2026-11-13", time: "15:00", role: "check-in", place: "Casa Azulejo" },
          { kind: "event", label: "Check-out", value: "2026-11-16", time: "11:00", role: "check-out", place: "Casa Azulejo" },
          { kind: "event", label: "Train arrives", value: "2026-11-13", time: "14:10", role: "arrive", mode: "train", number: "IC 521", place: "Santa Apolonia" },
        ],
      },
      guesthouse,
    );
    expect(facts.map((f) => f.subject)).toEqual([
      { role: "check-in", place: "Casa Azulejo" },
      { role: "check-out", place: "Casa Azulejo" },
      { role: "arrive", mode: "train", carrier: "IC", number: "521", place: "Santa Apolonia" },
    ]);
    // The identity is the reading's words, as before: an earlier yes still applies.
    expect(facts[0]!.id).toBe("event:2026-11-13 check-in 15:00");
  });

  it("a place the text does not contain is dropped and the date is kept", () => {
    const [fact] = proposedFacts(
      { document: "hotel-booking", facts: [{ kind: "event", label: "Check-in", value: "2026-11-13", role: "check-in", place: "Hotel Imaginario", number: "TP 999" }] },
      guesthouse,
    );
    expect(fact!.value).toBe("2026-11-13");
    expect(fact!.subject).toEqual({ role: "check-in" });
  });

  it("an unknown role is dropped and the date is kept", () => {
    const facts = proposedFacts(
      {
        document: "hotel-booking",
        facts: [
          { kind: "event", label: "Check-in", value: "2026-11-13", role: "teleport", place: "Casa Azulejo" },
          { kind: "event", label: "Check-out", value: "2026-11-16", role: "other" },
        ],
      },
      guesthouse,
    );
    expect(facts.map((f) => f.value)).toEqual(["2026-11-13", "2026-11-16"]);
    expect(facts.map((f) => f.subject)).toEqual([undefined, undefined]);
  });
});

describe("where a journey the model read leaves from", () => {
  const ticket = "Your flight TP 236 leaves San Francisco (SFO) at 18:10 on 12 November 2026 and lands in LIS at 14:05 on 13 November 2026.";

  it("a departure the model read at an airport keeps the airport's code", async () => {
    const facts = proposedFacts(
      {
        document: "itinerary",
        facts: [
          { kind: "event", label: "Departure", value: "2026-11-12", time: "18:10", role: "depart", place: "San Francisco (SFO)", number: "TP 236" },
          { kind: "event", label: "Arrival", value: "2026-11-13", time: "14:05", role: "arrive", place: "LIS" },
        ],
      },
      ticket,
    );
    expect(facts.map((f) => f.subject)).toEqual([
      { role: "depart", mode: "flight", carrier: "TP", number: "236", code: "SFO", place: "San Francisco (SFO)" },
      { role: "arrive", mode: "flight", code: "LIS", place: "LIS" },
    ]);
    const { zoneOf } = await import("./instants");
    expect(await zoneOf(facts[0]!, { tripZone: "Europe/Lisbon" })).toBe("America/Los_Angeles");
  });
});
