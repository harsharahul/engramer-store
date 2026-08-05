import { describe, expect, it } from "vitest";
import { aamvaFacts } from "./aamva";

// Synthetic. Element identifiers per the AAMVA card design standard; no real
// licence appears in this repository.
const US = [
  "@\n\rANSI 636000100002DL00410288ZV03290015DL",
  "DAQD12345678",
  "DCSPUBLIC",
  "DACJOHN",
  "DBD08242021",
  "DBB01311978",
  "DBA08242029",
  "DCAC",
  "\r",
].join("\n");

// A Canadian issuer writes the year first.
const CA = US.replace("636000", "636012")
  .replace("DBD08242021", "DBD20210824")
  .replace("DBB01311978", "DBB19780131")
  .replace("DBA08242029", "DBA20290824");

describe("aamvaFacts", () => {
  it("reads the expiry from a United States licence, month first", () => {
    const expiry = aamvaFacts(US, "f1").find((f) => f.kind === "expiry");
    expect(expiry).toMatchObject({
      value: "2029-08-24",
      document: "drivers-license",
      source: "barcode",
      confidence: 1,
    });
    expect(expiry!.ambiguous).toBeFalsy();
  });

  it("reads a Canadian licence, where the year comes first", () => {
    expect(aamvaFacts(CA, "f1").find((f) => f.kind === "expiry")!.value).toBe("2029-08-24");
  });

  it("masks the licence number in the summary", () => {
    const id = aamvaFacts(US, "f1").find((f) => f.kind === "identifier");
    expect(id!.value).toBe("D12345678");
    expect(id!.masked).toBe("5678");
  });

  it("reads the issue date", () => {
    expect(aamvaFacts(US, "f1").find((f) => f.kind === "issued")!.value).toBe("2021-08-24");
  });

  it("does not record the date of birth", () => {
    const values = aamvaFacts(US, "f1").map((f) => f.value);
    expect(values).not.toContain("1978-01-31");
    expect(values).not.toContain("1978-31-01");
  });

  it("skips a field whose digits are not a real date", () => {
    const broken = US.replace("DBA08242029", "DBA02302029");
    expect(broken).toContain("DBA02302029");
    expect(aamvaFacts(broken, "f1").some((f) => f.kind === "expiry")).toBe(false);
  });

  it("skips a licence marked as never expiring rather than inventing a date", () => {
    const forever = US.replace("DBA08242029", "DBA        ");
    expect(aamvaFacts(forever, "f1").some((f) => f.kind === "expiry")).toBe(false);
  });

  it("still reads the other fields when one is unreadable", () => {
    const broken = US.replace("DBA08242029", "DBA02302029");
    expect(aamvaFacts(broken, "f1").find((f) => f.kind === "identifier")!.value).toBe("D12345678");
  });

  it("returns nothing for a payload that is not an AAMVA record", () => {
    expect(aamvaFacts("https://example.com", "f1")).toEqual([]);
    expect(aamvaFacts("", "f1")).toEqual([]);
  });
});
