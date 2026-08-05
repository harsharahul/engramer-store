import { describe, expect, it } from "vitest";
import { scanForFacts } from "./scan";

const base = { name: "policy.pdf", mime: "application/pdf" };

describe("scanForFacts", () => {
  it("reads facts out of extracted text with no file present", async () => {
    const out = await scanForFacts({
      ...base,
      text: "Certificate of Motor Insurance\nValid until 2027-04-30",
    });
    expect(out.facts.find((f) => f.kind === "expiry")).toMatchObject({
      value: "2027-04-30",
      document: "insurance",
      source: "label",
    });
  });

  it("marks every fact unconfirmed, whatever it came from", async () => {
    const out = await scanForFacts({ ...base, text: "Expires 2027-04-30" });
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.every((f) => !f.confirmed)).toBe(true);
  });

  it("prefers the machine-readable zone over a date printed beside it", async () => {
    const zone =
      "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n" +
      "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
    const out = await scanForFacts({ ...base, text: `Expires 15 April 2012\n${zone}` });
    const expiry = out.facts.find((f) => f.kind === "expiry");
    expect(expiry).toMatchObject({ value: "2012-04-15", source: "mrz", confidence: 1 });
  });

  it("keeps the full reference number out of the summary and puts it in evidence", async () => {
    const out = await scanForFacts({
      ...base,
      text: "Policy number AB1234567890\nExpires 2027-04-30",
    });
    const id = out.facts.find((f) => f.kind === "identifier");
    expect(id).toBeDefined();
    expect(id!.value).toBe("7890");
    expect(id!.masked).toBe("7890");
    // Nothing anywhere in the summary may carry the whole number.
    expect(JSON.stringify(out.facts)).not.toContain("AB1234567890");
    expect(out.evidence.find((e) => e.id === id!.id)!.full).toBe("AB1234567890");
  });

  it("discards a value the document does not actually contain", async () => {
    // Grounding is exercised through the real pipeline, not only in isolation.
    const out = await scanForFacts({ ...base, text: "This document mentions no dates." });
    expect(out.facts.filter((f) => f.kind === "expiry")).toEqual([]);
  });

  it("reads the form that exposed the vocabulary's limit", async () => {
    const out = await scanForFacts({
      name: "benefits-statement.pdf",
      mime: "application/pdf",
      text: "Enrollment Record Number: X90000012B3\nEnrollment/Issued Date: 2027 April 12\nCoverage Class: R2\nBenefit End Date: 2027 October 19",
    });
    // The controlling date, quoted in the document's own words.
    expect(out.facts.find((f) => f.kind === "dated")).toMatchObject({
      value: "2027-10-19",
      label: "Benefit End Date",
    });
    expect(out.facts.find((f) => f.kind === "issued")?.value).toBe("2027-04-12");
    expect(out.facts.find((f) => f.kind === "identifier")?.masked).toBe("12B3");
  });

  it("returns nothing at all for a file with no text and no bytes", async () => {
    const out = await scanForFacts({ name: "a.zip", mime: "application/zip" });
    expect(out.facts).toEqual([]);
    expect(out.evidence).toEqual([]);
    expect(out.decoded).toEqual([]);
  });

  it("never carries more facts than a file is allowed", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Ref AB${i}00000${i}`).join("\n");
    const out = await scanForFacts({ ...base, text: many });
    expect(out.facts.length).toBeLessThanOrEqual(12);
  });
});
