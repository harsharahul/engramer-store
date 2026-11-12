// Days are counted from the device's day; these tests state their moments in UTC.
process.env.TZ = "UTC";

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

describe("a date written with dots", () => {
  it("is day first, as the countries that write dates with dots write them", () => {
    expect(parseDate("Zahlbar bis 12.11.2026")).toEqual({ iso: "2026-11-12", ambiguous: true });
    expect(parseDate("03.04.2028")).toEqual({ iso: "2028-04-03", ambiguous: true });
    expect(parseDate("30.11.2026")).toEqual({ iso: "2026-11-30", ambiguous: false });
  });

  it("leaves a date written with slashes or hyphens as it was read", () => {
    expect(parseDate("03/04/2028")).toEqual({ iso: "2028-03-04", ambiguous: true });
    expect(parseDate("03-04-2028")).toEqual({ iso: "2028-03-04", ambiguous: true });
    expect(parseDate("12.25.2028")).toEqual({ iso: "2028-12-25", ambiguous: false });
  });
});

describe("a date with no year", () => {
  const WRITTEN = Date.parse("2026-11-09T12:00:00Z"); // Monday 9 Nov 2026
  const at = { writtenAt: WRITTEN };

  it("takes the next such day after the message was written", () => {
    expect(parseDate("Thursday, November 12", at)).toEqual({ iso: "2026-11-12", ambiguous: false, assumedYear: true });
    expect(parseDate("Jan 5", at)?.iso).toBe("2027-01-05");
    expect(parseDate("12 November", at)?.iso).toBe("2026-11-12");
    expect(parseDate("Thu 12 Nov", at)?.iso).toBe("2026-11-12");
    expect(parseDate("arriving November 12th", at)?.iso).toBe("2026-11-12");
    expect(parseDate("on 4 Sept.", at)?.iso).toBe("2027-09-04");
  });

  it("a weekday that does not match drops the date", () => {
    expect(parseDate("Friday, November 12", at)).toBeNull();
    expect(parseDate("Fri 12 Nov", at)).toBeNull();
  });

  it("a date more than 11 months on, or with no anchor, is not read", () => {
    expect(parseDate("November 1", at)).toBeNull();
    expect(parseDate("Thursday, November 12")).toBeNull();
    expect(parseDate("12 November")).toBeNull();
  });

  it("a date that states its year never uses the anchor", () => {
    expect(parseDate("November 12, 2031", at)).toEqual({ iso: "2031-11-12", ambiguous: false });
    expect(parseDate("12 Nov 2031", at)).toEqual({ iso: "2031-11-12", ambiguous: false });
  });

  it("the day the message was written counts, seen from a zone a day ahead", () => {
    // Sent on the evening of Wednesday 11 November in California: already the 12th in UTC.
    expect(parseDate("Wednesday, November 11", { writtenAt: Date.parse("2026-11-12T03:00:00Z") })?.iso).toBe("2026-11-11");
  });

  it("the 29th of February is the next one that exists", () => {
    expect(parseDate("February 29", { writtenAt: Date.parse("2027-12-01T12:00:00Z") })?.iso).toBe("2028-02-29");
    expect(parseDate("February 29", { writtenAt: Date.parse("2026-12-01T12:00:00Z") })).toBeNull();
  });

  it("a word that only starts like a month, or a month in lower case, is not a date", () => {
    for (const text of ["Mayor 12", "Room 12", "may 12", "12 marchers", "Suite 5", "March 2029"]) {
      expect(parseDate(text, at), text).toBeNull();
    }
  });
});

describe("a clock after the day is not its year", () => {
  it("reads no year out of an hour", () => {
    expect(parseDate("November 12, 10:30")).toBeNull();
    expect(parseDate("12 November 19:30")).toBeNull();
    expect(parseDate("November 12, 10:30", { writtenAt: Date.parse("2026-11-09T12:00:00Z") })?.iso).toBe("2026-11-12");
  });

  it("still reads a two-digit year that is one", () => {
    expect(parseDate("12 March 29")?.iso).toBe("2029-03-12");
    expect(parseDate("March 12, 29")?.iso).toBe("2029-03-12");
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

  it("reads a clock written without a colon", () => {
    expect([parseTime("from 3pm"), parseTime("by 11 am"), parseTime("doors 7 PM"), parseTime("at 12am"), parseTime("12 pm"), parseTime("5 p.m.")]).toEqual([
      "15:00",
      "11:00",
      "19:00",
      "00:00",
      "12:00",
      "17:00",
    ]);
  });

  it("a bare number is not a clock", () => {
    const not = ["room 3", "3 people", "15 March 2027", "10 Amsterdam", "2027 pm", "13 pm", "1.05 pm"];
    expect(not.map((text) => parseTime(text))).toEqual(not.map(() => null));
  });

  it("a clock with a colon wins over one without", () => {
    expect(parseTime("3pm show, doors 18:30")).toBe("18:30");
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
