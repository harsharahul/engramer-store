import { describe, expect, it } from "vitest";
import { guessDocumentKind, harvestFacts, labelledFacts, structuralDatedFacts } from "./labels";

describe("labelledFacts", () => {
  it("reads an expiry behind its label", () => {
    const [fact] = labelledFacts("Policy holder: H R\nExpires 12 March 2029");
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
      expect(labelledFacts(`${label}: 2029-03-12`)[0]?.kind).toBe("expiry");
    }
  });

  it("separates a payment due date from an expiry", () => {
    const [fact] = labelledFacts("Payment due 2026-09-01");
    expect(fact).toMatchObject({ kind: "due", value: "2026-09-01" });
  });

  it("reads an issue date", () => {
    expect(labelledFacts("Date of issue: 2021-08-24")[0]?.kind).toBe("issued");
  });

  it("carries ambiguity through from the date reader", () => {
    const [fact] = labelledFacts("Expires 03/04/2028");
    expect(fact!.ambiguous).toBe(true);
    expect(fact!.confidence).toBeLessThan(0.7);
  });

  it("is more confident about a date that could only be read one way", () => {
    expect(labelledFacts("Expires 2029-03-12")[0]!.confidence).toBe(0.7);
  });

  it("ignores a label with no date anywhere near it", () => {
    expect(labelledFacts("Expires when the policy is cancelled.")).toEqual([]);
  });

  it("does not reach across a paragraph for its date", () => {
    const text = `Expires\n\n${"filler line\n".repeat(12)}2029-03-12`;
    expect(labelledFacts(text)).toEqual([]);
  });

  it("gives two facts with the same value distinct identities by kind", () => {
    const facts = labelledFacts("Issued 2029-03-12. Expires 2029-03-12.");
    const ids = new Set(facts.map((f) => f.id));
    expect(ids.size).toBe(facts.length);
  });

  it("finds every label in a document, not only the first", () => {
    const facts = labelledFacts("Expires 2029-03-12\nPayment due 2026-09-01");
    expect(facts.map((f) => f.kind).sort()).toEqual(["due", "expiry"]);
  });
});

describe("structuralDatedFacts", () => {
  // The shape that exposed the vocabulary's limit, recreated with synthetic values.
  const STATEMENT = `Enrollment Record Number: X90000012B3
Enrollment/Issued Date: 2027 April 12
Coverage Class: R2
Benefit End Date: 2027 October 19
Details provided on the enrollment form:`;

  it("surfaces a labelled date the vocabulary does not know, label attached", () => {
    const facts = structuralDatedFacts(STATEMENT, new Set());
    const admit = facts.find((f) => f.value === "2027-10-19");
    expect(admit).toMatchObject({
      kind: "dated",
      label: "Benefit End Date",
      source: "label",
    });
  });

  it("skips a value the vocabulary already claimed, so nothing appears twice", () => {
    expect(
      structuralDatedFacts("Valid until: 2027-04-30", new Set(["2027-04-30"])),
    ).toEqual([]);
  });

  it("refuses a date of birth outright", () => {
    expect(structuralDatedFacts("Date of Birth: 1978-01-31", new Set())).toEqual([]);
  });

  it("refuses print and generation stamps, which describe the paper", () => {
    expect(structuralDatedFacts("Printed on: 2026-01-02", new Set())).toEqual([]);
    expect(structuralDatedFacts("Generated: 2026-01-02", new Set())).toEqual([]);
  });

  it("ignores a field whose value holds no date", () => {
    expect(structuralDatedFacts("Coverage Class: R2", new Set())).toEqual([]);
  });

  it("carries ambiguity through, so the card can ask which reading", () => {
    const [fact] = structuralDatedFacts("Fecha de vencimiento: 03/04/2028", new Set());
    expect(fact).toMatchObject({ kind: "dated", ambiguous: true });
  });
});

describe("the whole statement, end to end through the readers", () => {
  const STATEMENT = `Enrollment Record Number: X90000012B3
Enrollment/Issued Date: 2027 April 12
Coverage Class: R2
Benefit End Date: 2027 October 19`;

  it("types what it knows and quotes what it does not", () => {
    const typed = labelledFacts(STATEMENT);
    // "Enrollment/Issued Date" carries a label the vocabulary knows.
    expect(typed.find((f) => f.kind === "issued")?.value).toBe("2027-04-12");
    const claimed = new Set(typed.map((f) => f.value));
    const generic = structuralDatedFacts(STATEMENT, claimed);
    // The controlling date surfaces with the document's own words, even
    // though nothing here knows what a benefits statement is.
    expect(generic).toHaveLength(1);
    expect(generic[0]).toMatchObject({ value: "2027-10-19", label: "Benefit End Date" });
  });
});

describe("harvestFacts", () => {
  it("finds a currency amount and marks it low confidence", () => {
    const [fact] = harvestFacts("Total due: $410.00");
    expect(fact).toMatchObject({
      kind: "amount",
      value: "410.00",
      unit: "USD",
      source: "pattern",
    });
    expect(fact!.confidence).toBeLessThan(0.5);
  });

  it("reads a currency written as a code", () => {
    expect(harvestFacts("Amount: EUR 1250.50")[0]).toMatchObject({
      value: "1250.50",
      unit: "EUR",
    });
  });

  it("never proposes a bare date with no label as an expiry", () => {
    expect(harvestFacts("Printed 2026-01-02").some((f) => f.kind === "expiry")).toBe(false);
  });

  it("masks a reference number rather than carrying it whole", () => {
    const id = harvestFacts("Policy number AB1234567890").find((f) => f.kind === "identifier");
    expect(id!.masked).toBe("7890");
    expect(id!.value).toBe("AB1234567890");
  });

  it("does not treat an ordinary word as a reference number", () => {
    expect(harvestFacts("thank you for your business")).toEqual([]);
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

describe("travel vocabulary", () => {
  it("types a check-in date as an event and carries its time", () => {
    const [fact] = labelledFacts("The Larkspur Hotel\nCheck-in: March 04, 2027 from 15:00");
    expect(fact).toMatchObject({ kind: "event", value: "2027-03-04", time: "15:00" });
    expect(fact!.label).toBe("Check-in");
  });

  it("types departure and boarding, keeping labels as written", () => {
    const facts = labelledFacts("Departure: 4 March 2027 09:40\nBoarding time: 4 March 2027 09:10");
    expect(facts.map((f) => f.label)).toEqual(["Departure", "Boarding time"]);
    expect(facts.every((f) => f.kind === "event")).toBe(true);
    expect(facts.map((f) => f.time)).toEqual(["09:40", "09:10"]);
  });

  it("keeps two same-day events apart", () => {
    const facts = labelledFacts("Check-in: 4 March 2027\nCheck-out: 4 March 2027");
    expect(facts).toHaveLength(2);
  });

  it("emits nothing for an event label with no date in reach", () => {
    expect(labelledFacts("Check-in desk is on level 2")).toEqual([]);
  });

  it("does not mistake the words boarding pass for a boarding time", () => {
    const facts = labelledFacts("Boarding pass\nDeparture: 4 March 2027 09:40");
    expect(facts.map((f) => f.label)).toEqual(["Departure"]);
  });

  it("recognizes travel documents by kind", () => {
    expect(guessDocumentKind("BOARDING PASS  Gate C12  Seat 14C")).toBe("boarding-pass");
    expect(guessDocumentKind("Hotel Reservation. Confirmation number LRK-1")).toBe("hotel-booking");
    expect(guessDocumentKind("Car Rental Agreement")).toBe("car-rental");
    expect(guessDocumentKind("Your flight itinerary")).toBe("itinerary");
  });
});
