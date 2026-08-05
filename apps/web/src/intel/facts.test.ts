import { describe, expect, it } from "vitest";
import { groundFacts, maskTail, mergeFacts, type Fact } from "./facts";

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "f1",
  kind: "expiry",
  document: "drivers-license",
  value: "2029-03-12",
  source: "label",
  confidence: 0.7,
  ...over,
});

describe("groundFacts", () => {
  it("keeps a fact whose date appears in the source", () => {
    expect(groundFacts([fact()], "Expires 03/12/2029")).toHaveLength(1);
  });

  it("discards a fact whose date appears nowhere in the source", () => {
    expect(groundFacts([fact()], "Expires 04/01/2030")).toHaveLength(0);
  });

  it("matches a date written the long way", () => {
    expect(groundFacts([fact()], "Valid until 12 March 2029")).toHaveLength(1);
  });

  it("matches a date written month first", () => {
    expect(groundFacts([fact()], "Valid until March 12, 2029")).toHaveLength(1);
  });

  it("never discards a fact the user entered by hand", () => {
    const typed = fact({ source: "user", value: "2031-01-01" });
    expect(groundFacts([typed], "nothing relevant here")).toHaveLength(1);
  });

  it("never discards a structured read, which has no free text to match", () => {
    expect(groundFacts([fact({ source: "barcode" })], "")).toHaveLength(1);
  });

  it("grounds a non-date value literally", () => {
    const amount = fact({ kind: "amount", value: "410.00", source: "pattern" });
    expect(groundFacts([amount], "Total due: $410.00")).toHaveLength(1);
    expect(groundFacts([amount], "Total due: $9.99")).toHaveLength(0);
  });
});

describe("maskTail", () => {
  it("keeps only the last four characters", () => {
    expect(maskTail("D1234567")).toBe("4567");
  });

  it("returns a short value unchanged rather than revealing nothing", () => {
    expect(maskTail("123")).toBe("123");
  });
});

describe("mergeFacts", () => {
  it("keeps a confirmed fact even when a rescan no longer finds it", () => {
    const confirmed = fact({ confirmed: true });
    expect(mergeFacts([confirmed], [])).toEqual([confirmed]);
  });

  it("does not resurrect a dismissed fact", () => {
    const dismissed = fact({ dismissed: true });
    expect(mergeFacts([dismissed], [fact()])[0]!.dismissed).toBe(true);
  });

  it("prefers the higher-confidence source when both found the same value", () => {
    const merged = mergeFacts([fact()], [fact({ source: "mrz", confidence: 1 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("mrz");
  });

  it("leaves a weaker rescan of the same value alone", () => {
    const merged = mergeFacts([fact({ source: "mrz", confidence: 1 })], [fact()]);
    expect(merged[0]!.source).toBe("mrz");
  });

  it("appends a value the file did not carry before", () => {
    const found = fact({ id: "f2", kind: "due", value: "2026-09-01" });
    expect(mergeFacts([fact()], [found])).toHaveLength(2);
  });

  it("caps how many facts one file may carry, dropping the weakest", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      fact({
        id: `f${i}`,
        value: `2029-03-${String((i % 28) + 1).padStart(2, "0")}`,
        confidence: i === 0 ? 1 : 0.3,
      }),
    );
    const merged = mergeFacts([], many);
    expect(merged.length).toBeLessThanOrEqual(12);
    expect(merged[0]!.confidence).toBe(1);
  });
});
