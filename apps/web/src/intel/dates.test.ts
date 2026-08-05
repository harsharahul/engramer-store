import { describe, expect, it } from "vitest";
import { daysUntil, parseDate } from "./dates";

describe("parseDate", () => {
  it("reads an unambiguous slash date, where the first number cannot be a month", () => {
    expect(parseDate("25/12/2028")).toEqual({ iso: "2028-12-25", ambiguous: false });
  });

  it("reads an unambiguous slash date, where the second number cannot be a month", () => {
    expect(parseDate("12/25/2028")).toEqual({ iso: "2028-12-25", ambiguous: false });
  });

  it("marks a genuinely ambiguous slash date rather than guessing", () => {
    expect(parseDate("03/04/2028")).toEqual({ iso: "2028-03-04", ambiguous: true });
  });

  it("resolves an ambiguous date when the issuer's order is known", () => {
    expect(parseDate("03/04/2028", "dmy")).toEqual({ iso: "2028-04-03", ambiguous: false });
    expect(parseDate("03/04/2028", "mdy")).toEqual({ iso: "2028-03-04", ambiguous: false });
  });

  it("accepts dots and dashes as separators", () => {
    expect(parseDate("25.12.2028")?.iso).toBe("2028-12-25");
    expect(parseDate("25-12-2028")?.iso).toBe("2028-12-25");
  });

  it("reads a written month with no ambiguity", () => {
    expect(parseDate("12 March 2029")).toEqual({ iso: "2029-03-12", ambiguous: false });
    expect(parseDate("March 12, 2029")).toEqual({ iso: "2029-03-12", ambiguous: false });
    expect(parseDate("12 Mar 2029")).toEqual({ iso: "2029-03-12", ambiguous: false });
  });

  it("reads an ISO date", () => {
    expect(parseDate("2029-03-12")).toEqual({ iso: "2029-03-12", ambiguous: false });
  });

  it("reads a compact eight-digit date when told the order", () => {
    expect(parseDate("20290312", "ymd")).toEqual({ iso: "2029-03-12", ambiguous: false });
    expect(parseDate("03122029", "mdy")).toEqual({ iso: "2029-03-12", ambiguous: false });
  });

  it("expands a two-digit year into the nearest sensible century", () => {
    expect(parseDate("12/03/29")?.iso).toBe("2029-12-03");
    expect(parseDate("12/03/85")?.iso).toBe("1985-12-03");
  });

  it("rejects an impossible date instead of rolling it over", () => {
    expect(parseDate("02/31/2028")).toBeNull();
    expect(parseDate("13/13/2028")).toBeNull();
    expect(parseDate("31 February 2028")).toBeNull();
  });

  it("accepts the leap day in a leap year and rejects it otherwise", () => {
    expect(parseDate("29 February 2028")?.iso).toBe("2028-02-29");
    expect(parseDate("29 February 2027")).toBeNull();
  });

  it("returns null for text holding no date", () => {
    expect(parseDate("no date here")).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("finds a date inside a longer phrase", () => {
    expect(parseDate("Expires on 2029-03-12 unless renewed")?.iso).toBe("2029-03-12");
  });
});

describe("daysUntil", () => {
  const now = Date.UTC(2026, 7, 4);

  it("counts forward to a future date", () => {
    expect(daysUntil("2026-08-14", now)).toBe(10);
  });

  it("goes negative for a date already past", () => {
    expect(daysUntil("2026-07-25", now)).toBe(-10);
  });

  it("calls today zero", () => {
    expect(daysUntil("2026-08-04", now)).toBe(0);
  });
});
