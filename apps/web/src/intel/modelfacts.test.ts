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
    expect(Object.keys((item as { properties: object }).properties).sort()).toEqual(["kind", "label", "time", "value"]);
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
