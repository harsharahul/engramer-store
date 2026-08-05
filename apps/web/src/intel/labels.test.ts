import { describe, expect, it } from "vitest";
import { guessDocumentKind, harvestFacts, labelledFacts } from "./labels";

describe("labelledFacts", () => {
  it("reads an expiry behind its label", () => {
    const [fact] = labelledFacts("Policy holder: H R\nExpires 12 March 2029", "f1");
    expect(fact).toMatchObject({ kind: "expiry", value: "2029-03-12", source: "label" });
  });

  it("reads the variants people actually print", () => {
    for (const label of [
      "Valid until",
      "Valid through",
      "Date of expiry",
      "Expiry date",
      "Expiration date",
      "Renewal date",
      "Good through",
    ]) {
      expect(labelledFacts(`${label}: 2029-03-12`, "f1")[0]?.kind).toBe("expiry");
    }
  });

  it("separates a payment due date from an expiry", () => {
    const [fact] = labelledFacts("Payment due 2026-09-01", "f1");
    expect(fact).toMatchObject({ kind: "due", value: "2026-09-01" });
  });

  it("reads an issue date", () => {
    expect(labelledFacts("Date of issue: 2021-08-24", "f1")[0]?.kind).toBe("issued");
  });

  it("carries ambiguity through from the date reader", () => {
    const [fact] = labelledFacts("Expires 03/04/2028", "f1");
    expect(fact!.ambiguous).toBe(true);
    expect(fact!.confidence).toBeLessThan(0.7);
  });

  it("is more confident about a date that could only be read one way", () => {
    expect(labelledFacts("Expires 2029-03-12", "f1")[0]!.confidence).toBe(0.7);
  });

  it("ignores a label with no date anywhere near it", () => {
    expect(labelledFacts("Expires when the policy is cancelled.", "f1")).toEqual([]);
  });

  it("does not reach across a paragraph for its date", () => {
    const text = `Expires\n\n${"filler line\n".repeat(12)}2029-03-12`;
    expect(labelledFacts(text, "f1")).toEqual([]);
  });

  it("gives two facts with the same value distinct identities by kind", () => {
    const facts = labelledFacts("Issued 2029-03-12. Expires 2029-03-12.", "f1");
    const ids = new Set(facts.map((f) => f.id));
    expect(ids.size).toBe(facts.length);
  });

  it("finds every label in a document, not only the first", () => {
    const facts = labelledFacts("Expires 2029-03-12\nPayment due 2026-09-01", "f1");
    expect(facts.map((f) => f.kind).sort()).toEqual(["due", "expiry"]);
  });
});

describe("harvestFacts", () => {
  it("finds a currency amount and marks it low confidence", () => {
    const [fact] = harvestFacts("Total due: $410.00", "f1");
    expect(fact).toMatchObject({
      kind: "amount",
      value: "410.00",
      unit: "USD",
      source: "pattern",
    });
    expect(fact!.confidence).toBeLessThan(0.5);
  });

  it("reads a currency written as a code", () => {
    expect(harvestFacts("Amount: EUR 1250.50", "f1")[0]).toMatchObject({
      value: "1250.50",
      unit: "EUR",
    });
  });

  it("never proposes a bare date with no label as an expiry", () => {
    expect(harvestFacts("Printed 2026-01-02", "f1").some((f) => f.kind === "expiry")).toBe(false);
  });

  it("masks a reference number rather than carrying it whole", () => {
    const id = harvestFacts("Policy number AB1234567890", "f1").find((f) => f.kind === "identifier");
    expect(id!.masked).toBe("7890");
    expect(id!.value).toBe("AB1234567890");
  });

  it("does not treat an ordinary word as a reference number", () => {
    expect(harvestFacts("thank you for your business", "f1")).toEqual([]);
  });
});

describe("guessDocumentKind", () => {
  it("recognizes the documents the rules care about", () => {
    expect(guessDocumentKind("UNITED STATES PASSPORT")).toBe("passport");
    expect(guessDocumentKind("DRIVER LICENSE  CLASS C")).toBe("drivers-license");
    expect(guessDocumentKind("Certificate of Motor Insurance")).toBe("insurance");
    expect(guessDocumentKind("Limited Warranty")).toBe("warranty");
    expect(guessDocumentKind("INVOICE #2231")).toBe("invoice");
    expect(guessDocumentKind("Residence Permit")).toBe("residence-permit");
  });

  it("says other rather than inventing a kind", () => {
    expect(guessDocumentKind("a shopping list")).toBe("other");
  });
});
