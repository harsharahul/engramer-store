import { describe, expect, it } from "vitest";
import { bcbpFacts, bcbpLeg } from "./bcbp";

// Entirely synthetic: invented passenger, code, route, date.
const PASS = "M1RIVERS/JORDAN       EZK8Q2P SFOJFKAQ 0214 063Y014C0041 100";
const STORED = Date.UTC(2027, 1, 20); // 20 Feb 2027; day 063 = 4 Mar 2027

describe("bcbpLeg", () => {
  it("reads the mandatory fields", () => {
    expect(bcbpLeg(PASS)).toEqual({
      pnr: "ZK8Q2P",
      from: "SFO",
      to: "JFK",
      carrier: "AQ",
      flight: "214",
      julian: 63,
    });
  });

  it("refuses payloads that are not boarding passes", () => {
    expect(bcbpLeg("hello world")).toBeNull();
    expect(bcbpLeg("M1TOO SHORT")).toBeNull();
    expect(bcbpLeg(PASS.replace("SFO", "S1O"))).toBeNull();
  });
});

describe("bcbpFacts", () => {
  it("emits the flight as an inferred-year event and the reference as an identifier", () => {
    const facts = bcbpFacts(PASS, STORED);
    const event = facts.find((fact) => fact.kind === "event");
    expect(event).toMatchObject({
      value: "2027-03-04",
      source: "barcode",
      document: "boarding-pass",
    });
    // The year is inferred from when the pass was stored, not stated by the
    // barcode, so the fact stays below structured confidence and gets offered.
    expect(event!.confidence).toBeLessThan(1);
    expect(event!.label).toContain("AQ 214");
    expect(event!.label).toContain("SFO");
    const ref = facts.find((fact) => fact.kind === "identifier");
    expect(ref).toMatchObject({ value: "ZK8Q2P", source: "barcode", confidence: 1 });
  });

  it("picks the year that lands the flight nearest the stored date", () => {
    // Day 010 stored in late December belongs to the coming January.
    const winter = "M1RIVERS/JORDAN       EZK8Q2P SFOJFKAQ 0214 010Y014C0041 100";
    const [event] = bcbpFacts(winter, Date.UTC(2026, 11, 28)).filter(
      (fact) => fact.kind === "event",
    );
    expect(event!.value).toBe("2027-01-10");
  });

  it("returns nothing at all when validation fails", () => {
    expect(bcbpFacts("M1 garbage", STORED)).toEqual([]);
  });
});

describe("year inference boundaries", () => {
  it("refuses to resolve a flight into the distant past", () => {
    // Day 063 stored in August: that March is long gone; the pass means the
    // coming one, not the nearest one.
    const [event] = bcbpFacts(PASS, Date.UTC(2026, 7, 5)).filter((f) => f.kind === "event");
    expect(event!.value).toBe("2027-03-04");
  });

  it("lets a pass stored just after the trip keep its recent date", () => {
    const [event] = bcbpFacts(PASS, Date.UTC(2027, 2, 10)).filter((f) => f.kind === "event");
    expect(event!.value).toBe("2027-03-04");
  });
});
