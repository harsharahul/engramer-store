import { describe, expect, it } from "vitest";
import { describeFact, shown, whenLabel, withArticle } from "./describe";
import type { Fact } from "./facts";

const NOW = Date.UTC(2026, 7, 5);

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "expiry:2027-04-30",
  kind: "expiry",
  document: "insurance",
  value: "2027-04-30",
  source: "label",
  confidence: 0.7,
  ...over,
});

describe("shown", () => {
  it("writes a date the way a person would", () => {
    expect(shown("2027-04-30")).toBe("30 April 2027");
    expect(shown("2026-08-05")).toBe("5 August 2026");
  });

  it("leaves anything that is not a date alone", () => {
    expect(shown("410.00")).toBe("410.00");
  });
});

describe("withArticle", () => {
  it("says an before a vowel and a before anything else", () => {
    expect(withArticle("invoice due 28 July 2026")).toMatch(/^an /);
    expect(withArticle("insurance policy")).toMatch(/^an /);
    expect(withArticle("passport expiring soon")).toMatch(/^a /);
    expect(withArticle("driver's licence")).toMatch(/^a /);
  });
});

describe("describeFact", () => {
  it("names the document and what its date means", () => {
    expect(describeFact(fact())).toBe("insurance policy expiring 30 April 2027");
  });

  it("includes a time when the document gave one", () => {
    const flight = fact({ kind: "event", document: "boarding-pass", time: "09:40" });
    expect(describeFact(flight)).toBe("boarding pass on 30 April 2027 at 09:40");
  });

  it("calls an unfamiliar kind a document rather than printing its code", () => {
    expect(describeFact(fact({ document: "carbon-offset" as never }))).toContain("document");
  });
});

describe("whenLabel", () => {
  it("uses words for the near future", () => {
    expect(whenLabel("2026-08-05", NOW)).toBe("today");
    expect(whenLabel("2026-08-06", NOW)).toBe("tomorrow");
    expect(whenLabel("2026-08-04", NOW)).toBe("yesterday");
    expect(whenLabel("2026-08-26", NOW)).toBe("in 21 days");
  });

  it("counts backwards once a date has passed", () => {
    expect(whenLabel("2026-07-28", NOW)).toBe("8 days ago");
  });

  it("switches to months and years rather than counting to four hundred", () => {
    expect(whenLabel("2027-02-14", NOW)).toBe("in 6 months");
    expect(whenLabel("2028-04-03", NOW)).toBe("in 2 years");
  });

  it("never says one of anything plural", () => {
    // The day threshold is set so the months branch cannot produce "1 months";
    // the smallest it reaches is two. The year branch says "in a year".
    expect(whenLabel("2026-09-08", NOW)).toBe("in 34 days");
    expect(whenLabel("2026-09-20", NOW)).toBe("in 2 months");
    expect(whenLabel("2027-08-05", NOW)).toBe("in a year");
  });
});

describe("events speak their labels", () => {
  it("names a flight by the document's words, never as a generic pass", () => {
    const flight = fact({
      kind: "event",
      document: "boarding-pass",
      label: "Flight AQ 214 SFO to JFK",
      value: "2027-03-04",
    });
    expect(describeFact(flight)).toBe("Flight AQ 214 SFO to JFK, 4 March 2027");
  });

  it("carries the time when the event has one", () => {
    const checkin = fact({
      kind: "event",
      document: "hotel-booking",
      label: "Check-in: The Larkspur Hotel",
      value: "2027-03-04",
      time: "15:00",
    });
    expect(describeFact(checkin)).toBe("Check-in: The Larkspur Hotel, 4 March 2027 at 15:00");
  });
});
