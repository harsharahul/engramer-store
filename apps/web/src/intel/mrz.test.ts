import { describe, expect, it } from "vitest";
import { checkDigit, mrzFacts } from "./mrz";

// The ICAO 9303 specimen zone for a fictional state. No real travel document
// appears in this repository, and none should.
const LINE1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const LINE2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
const ZONE = `${LINE1}\n${LINE2}`;

describe("checkDigit", () => {
  it("weights 7, 3, 1 across the field", () => {
    expect(checkDigit("L898902C3")).toBe("6");
    expect(checkDigit("740812")).toBe("2");
    expect(checkDigit("120415")).toBe("9");
  });

  it("treats a filler character as zero", () => {
    expect(checkDigit("ZE184226B<<<<<")).toBe("1");
  });
});

describe("mrzFacts", () => {
  it("reads the expiry out of a valid zone", () => {
    const expiry = mrzFacts(ZONE, "f1").find((f) => f.kind === "expiry");
    expect(expiry).toMatchObject({
      value: "2012-04-15",
      document: "passport",
      source: "mrz",
      confidence: 1,
    });
    expect(expiry!.ambiguous).toBeFalsy();
  });

  it("masks the document number rather than storing it whole in the summary", () => {
    const id = mrzFacts(ZONE, "f1").find((f) => f.kind === "identifier");
    expect(id!.masked).toBe("02C3");
    expect(id!.value).toBe("L898902C3");
  });

  it("does not record the date of birth, which no rule here needs", () => {
    const values = mrzFacts(ZONE, "f1").map((f) => f.value);
    expect(values).not.toContain("1974-08-12");
  });

  it("rejects the whole read when a field check digit disagrees", () => {
    const broken = `${LINE2.slice(0, 21)}9${LINE2.slice(22)}`;
    expect(mrzFacts(`${LINE1}\n${broken}`, "f1")).toEqual([]);
  });

  it("rejects the whole read when the composite check digit disagrees", () => {
    const broken = `${LINE2.slice(0, 43)}7`;
    expect(mrzFacts(`${LINE1}\n${broken}`, "f1")).toEqual([]);
  });

  it("finds the zone even when the page around it was recognized too", () => {
    const page = `REPUBLIC OF UTOPIA\nPassport No L898902C3\n\n${ZONE}\n`;
    expect(mrzFacts(page, "f1").find((f) => f.kind === "expiry")!.value).toBe("2012-04-15");
  });

  it("tolerates the spaces character recognition inserts into the zone", () => {
    const spaced = `${LINE1}\n${LINE2.slice(0, 20)} ${LINE2.slice(20)}`;
    expect(mrzFacts(spaced, "f1").find((f) => f.kind === "expiry")!.value).toBe("2012-04-15");
  });

  it("calls a non-passport zone an identity card", () => {
    const idCard = `I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n${LINE2}`;
    expect(mrzFacts(idCard, "f1")[0]!.document).toBe("id-card");
  });

  it("finds nothing in ordinary prose", () => {
    expect(mrzFacts("This is a letter about a passport.", "f1")).toEqual([]);
  });

  it("finds nothing in an empty document", () => {
    expect(mrzFacts("", "f1")).toEqual([]);
  });
});
