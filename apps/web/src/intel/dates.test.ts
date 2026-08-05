import { describe, expect, it } from "vitest";
import { daysUntil, parseDate, parseTime, swappedReading } from "./dates";

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

  it("reads the year-first written form US government documents use", () => {
    // A benefits statement prints "Benefit End Date: 2027 October 19", and that date is
    // the controlling one on the page.
    expect(parseDate("2027 October 19")).toEqual({ iso: "2027-10-19", ambiguous: false });
    expect(parseDate("Benefit End Date: 2027 October 19")).toEqual({
      iso: "2027-10-19",
      ambiguous: false,
    });
    expect(parseDate("Enrollment/Issued Date: 2027 April 12")?.iso).toBe("2027-04-12");
  });

  it("reads a year-first numeric date, which only reads one way", () => {
    expect(parseDate("2027/10/19")).toEqual({ iso: "2027-10-19", ambiguous: false });
    expect(parseDate("2027.10.19")?.iso).toBe("2027-10-19");
  });

  it("rejects an impossible year-first date rather than shifting it", () => {
    expect(parseDate("2019 October 32")).toBeNull();
    expect(parseDate("2026/13/05")).toBeNull();
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

describe("swappedReading", () => {
  it("offers the other reading of an ambiguous date", () => {
    expect(swappedReading("2028-03-04")).toBe("2028-04-03");
  });

  it("returns null when the swap is not a real date", () => {
    expect(swappedReading("2028-03-25")).toBeNull();
    expect(swappedReading("2028-02-30")).toBeNull();
  });

  it("returns null for anything that is not an ISO date", () => {
    expect(swappedReading("410.00")).toBeNull();
  });
});

describe("parseTime", () => {
  it("reads a twenty-four hour time", () => {
    expect(parseTime("09:40")).toBe("09:40");
    expect(parseTime("21:05")).toBe("21:05");
  });

  it("pads a single-digit hour", () => {
    expect(parseTime("9:40")).toBe("09:40");
  });

  it("reads a twelve hour time with its marker", () => {
    expect(parseTime("9:40 PM")).toBe("21:40");
    expect(parseTime("9:40 am")).toBe("09:40");
    expect(parseTime("9:40p.m.")).toBe("21:40");
  });

  it("gets midnight and noon the right way round", () => {
    expect(parseTime("12:00 AM")).toBe("00:00");
    expect(parseTime("12:00 PM")).toBe("12:00");
  });

  it("finds a time inside a longer phrase", () => {
    expect(parseTime("Departs 09:40 from Terminal 4")).toBe("09:40");
  });

  it("does not mistake a dotted date for a time", () => {
    expect(parseTime("12.30.2029")).toBeNull();
  });

  it("rejects an impossible time", () => {
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("09:75")).toBeNull();
  });

  it("returns null when there is no time", () => {
    expect(parseTime("no time here")).toBeNull();
    expect(parseTime("")).toBeNull();
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
