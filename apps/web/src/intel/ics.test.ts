import { beforeAll, describe, expect, it } from "vitest";
import { lisbonFiles, lisbonTrip } from "./__fixtures__/lisbon";
import { factToCalendar, tripToCalendar } from "./ics";
import type { Fact } from "./facts";
import type { TripView } from "./tripview";

const STAMP = Date.UTC(2026, 7, 5, 12, 0, 0);

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "expiry:2027-10-19",
  kind: "expiry",
  document: "insurance",
  value: "2027-10-19",
  source: "label",
  confidence: 0.7,
  confirmed: true,
  ...over,
});

describe("factToCalendar", () => {
  it("builds an all-day event with an alarm the day before", () => {
    const { ics } = factToCalendar(fact(), "policy.pdf", STAMP);
    expect(ics).toContain("DTSTART;VALUE=DATE:20271019");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-PT15H");
    expect(ics).toContain("SUMMARY:insurance policy expiring 19 October 2027");
    // RFC 5545 wants CRLF, and calendar apps genuinely reject bare LF.
    expect(ics).toContain("\r\n");
    expect(ics.split("\r\n").join("")).not.toContain("\n");
  });

  it("uses the document's time as floating local time when one was given", () => {
    const flight = fact({ kind: "event", document: "boarding-pass", time: "09:40" });
    const { ics } = factToCalendar(flight, "pass.pdf", STAMP);
    // Floating, not UTC: a departure is local to its airport, and a wrong
    // zone that is visible beats one shifted confidently by five hours.
    expect(ics).toContain("DTSTART:20271019T094000");
    expect(ics).not.toContain("DTSTART:20271019T094000Z");
  });

  it("quotes an unknown label in the summary, escaped for the format", () => {
    const dated = fact({ kind: "dated", label: "Benefit End Date, final" });
    const { ics, filename } = factToCalendar(dated, "benefits statement.pdf", STAMP);
    expect(ics).toContain("Benefit End Date\\, final");
    expect(filename.endsWith(".ics")).toBe(true);
  });

  it("names the file it came from in the description", () => {
    expect(factToCalendar(fact(), "policy.pdf", STAMP).ics).toContain("From policy.pdf");
  });
});

describe("tripToCalendar", () => {
  let lisbon: TripView;
  beforeAll(async () => {
    lisbon = (await lisbonTrip()).view;
  });
  const bookings = (view: TripView) => view.booked.filter((row) => !row.ask).length;

  it("a trip exports each leg in real time, each stay as nights, each booking", () => {
    const { ics, filename } = tripToCalendar(lisbon, STAMP);
    expect(filename).toBe("lisbon-2026-11-12.ics");
    expect(ics).toContain("DTSTART:20261113T021000Z");
    expect(ics).toContain("DTEND:20261113T140500Z");
    expect(ics).toContain("SUMMARY:TP 236 SFO to LIS");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261113");
    expect(ics).toContain("DTEND;VALUE=DATE:20261116");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(lisbon.legs.length + lisbon.stays.length + bookings(lisbon));
  });

  it("the alarm rings at leave-by", () => {
    expect(tripToCalendar(lisbon, STAMP).ics).toContain("TRIGGER:-PT180M");
  });

  it("a second export updates the same events", () => {
    const uids = (ics: string) => ics.match(/^UID:.*$/gm);
    const first = uids(tripToCalendar(lisbon, STAMP).ics)!;
    expect(new Set(first).size).toBe(first.length);
    expect(uids(tripToCalendar(lisbon, STAMP + 60_000).ics)).toEqual(first);
  });

  it("a date nobody has said yes to is not exported", () => {
    const asking = { ...lisbon, legs: lisbon.legs.map((leg, i) => (i === 1 ? { ...leg, ask: true } : leg)) };
    expect(tripToCalendar(asking, STAMP).ics).not.toContain("TP 237");
  });

  it("a leg with no time exports as its day", async () => {
    const { view } = await lisbonTrip(lisbonFiles({ time: undefined }));
    expect(tripToCalendar(view, STAMP).ics).toContain("DTSTART;VALUE=DATE:20261116");
  });
});
