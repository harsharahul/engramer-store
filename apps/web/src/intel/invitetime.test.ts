// A meeting's invite names an instant, shown in the device's own zone on
// every surface. Pin a zone behind UTC, where the difference shows.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import { dueNotices } from "../notices";
import { itemsOf } from "./agenda";
import { rowsOf, type RowContext, type RowFile } from "./agendarows";
import { describeFact } from "./describe";
import { withExactAcceptance, type Fact } from "./facts";
import { factToCalendar } from "./ics";
import { shownWhen } from "./instants";

const none: RowContext = { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true };
// Mon 30 Nov 2026, 10:00 in San Francisco.
const NOW = new Date("2026-11-30T10:00:00-08:00").getTime();
const HOME = { inTrip: false };
const AWAY = { inTrip: true };
const TRIP = "trip:tokyo-2026-12";

const fact = (over: Partial<Fact>): Fact =>
  withExactAcceptance({ id: `event:${over.value} ${over.label}`, kind: "event", document: "other", value: "2026-12-02", label: "Team call", source: "ics", confidence: 1, ...over });

// 03:00 UTC on Wed 2 Dec is 19:00 on Tue 1 Dec in San Francisco.
const call = fact({ value: "2026-12-02", time: "03:00", zone: "UTC", label: "Team call" });
// 17:00 in New York is 14:00 in San Francisco.
const review = fact({ value: "2026-12-03", time: "17:00", zone: "America/New_York", label: "Design review" });
const floating = fact({ value: "2026-12-04", time: "09:00", label: "Dentist" });
const allDay = fact({ value: "2026-12-05", label: "Conference" });
// Bookings, from booking data and from a calendar file alike.
const flight = fact({ value: "2026-12-06", time: "18:10", zone: "-08:00", label: "Flight TP 236 departs SFO", source: "jsonld", document: "itinerary" });
const hotel = fact({ value: "2026-12-07", time: "15:00", zone: "UTC", label: "Check-in: Casa do Rio", source: "jsonld", document: "hotel-booking" });
const hotelInvite = fact({ value: "2026-12-07", time: "15:00", zone: "UTC", label: "Check-in: Casa do Rio" });
const flightInvite = fact({ value: "2026-12-07", time: "02:00", zone: "UTC", label: "Flight TP 236 departs SFO" });
const carInvite = fact({ value: "2026-12-08", time: "10:00", zone: "Europe/Lisbon", label: "Pick-up: Meridian Cars" });
// A tour on a trip to Tokyo, at 09:00 there.
const tour = fact({ value: "2026-12-10", time: "09:00", zone: "Asia/Tokyo", label: "Tsukiji tour" });

const file = (facts: Fact[], tags: string[] = []): RowFile & { createdAt: number } => ({
  id: "invites",
  name: "invites.ics",
  mime: "text/calendar",
  mtime: NOW,
  createdAt: NOW,
  tags,
  facts,
  trashed: false,
});

describe("the day and time a fact is shown at", () => {
  it("a meeting's instant is shown in the device's zone", () => {
    expect(shownWhen(call, HOME)).toEqual({ day: "2026-12-01", time: "19:00" });
    expect(shownWhen(review, HOME)).toEqual({ day: "2026-12-03", time: "14:00" });
  });

  it("an invite with no zone, or with no time, is shown as written", () => {
    expect(shownWhen(floating, HOME)).toEqual({ day: "2026-12-04", time: "09:00" });
    expect(shownWhen(allDay, HOME)).toEqual({ day: "2026-12-05" });
  });

  it("a booking keeps the clock of its place, whatever kind of file states it", () => {
    expect(shownWhen(flight, HOME)).toEqual({ day: "2026-12-06", time: "18:10" });
    expect(shownWhen(hotel, HOME)).toEqual({ day: "2026-12-07", time: "15:00" });
    expect(shownWhen(hotelInvite, HOME)).toEqual({ day: "2026-12-07", time: "15:00" });
    expect(shownWhen(flightInvite, HOME)).toEqual({ day: "2026-12-07", time: "02:00" });
    expect(shownWhen(carInvite, HOME)).toEqual({ day: "2026-12-08", time: "10:00" });
  });

  it("an invite that is part of a trip keeps the clock of the place it happens in", () => {
    expect(shownWhen(tour, AWAY)).toEqual({ day: "2026-12-10", time: "09:00" });
    // The same tour with no trip around it is a meeting like any other.
    expect(shownWhen(tour, HOME)).toEqual({ day: "2026-12-09", time: "16:00" });
  });

  it("an invite in a zone this device cannot read is shown as written", () => {
    expect(shownWhen(fact({ value: "2026-12-04", time: "09:00", zone: "Customized Time Zone" }), HOME)).toEqual({ day: "2026-12-04", time: "09:00" });
  });
});

describe("every surface shows an invite at the same day and time", () => {
  it("the Timeline row sits on the device's day, at the device's time, and keeps its instant", async () => {
    const rows = await rowsOf([file([call, review, floating])], none, NOW);
    expect(rows.map((row) => [row.title, row.day, row.time, row.at])).toEqual([
      ["Team call", "2026-12-01", "19:00", Date.UTC(2026, 11, 2, 3, 0)],
      ["Design review", "2026-12-03", "14:00", Date.UTC(2026, 11, 3, 22, 0)],
      ["Dentist", "2026-12-04", "09:00", new Date("2026-12-04T09:00:00-08:00").getTime()],
    ]);
  });

  it("a tour in a trip's file sits on the trip's own day, at the place's time", async () => {
    const [row] = await rowsOf([file([tour], [TRIP])], none, NOW);
    expect([row!.title, row!.day, row!.time]).toEqual(["Tsukiji tour", "2026-12-10", "09:00"]);
    expect(describeFact(tour, AWAY)).toBe("Tsukiji tour, 10 December 2026 at 09:00");
  });

  it("a hotel and a car stated in a calendar file read as the place printed them, on the row and in the words", async () => {
    const rows = await rowsOf([file([hotelInvite, carInvite])], none, NOW);
    expect(rows.map((row) => [row.kind, row.day, row.time])).toEqual([
      ["stay", "2026-12-07", "15:00"],
      ["event", "2026-12-08", "10:00"],
    ]);
    expect(describeFact(hotelInvite, HOME)).toBe("Check-in: Casa do Rio, 7 December 2026 at 15:00");
  });

  it("a flight stated in a calendar file shows one time, not two", async () => {
    const [row] = await rowsOf([file([flightInvite])], none, NOW);
    expect([row!.kind, row!.day, row!.time]).toEqual(["flight", "2026-12-07", "02:00"]);
    expect(describeFact(flightInvite, HOME)).toBe("Flight TP 236 departs SFO, 7 December 2026 at 02:00");
  });

  it("the words in the details pane, the bell and a notification say the same", () => {
    expect(describeFact(call, HOME)).toBe("Team call, 1 December 2026 at 19:00");
    expect(describeFact(review, HOME)).toBe("Design review, 3 December 2026 at 14:00");
    expect(describeFact(hotel, HOME)).toBe("Check-in: Casa do Rio, 7 December 2026 at 15:00");
    const notice = dueNotices([file([call])], NOW).find((entry) => entry.key.startsWith("fact:"));
    expect(notice?.title).toBe("Team call, 1 December 2026 at 19:00");
  });

  it("the days to a meeting are counted to the device's day, and to a trip's tour on the trip's day", () => {
    expect(itemsOf([file([call])], NOW, { name: "coming-up" })[0]!.days).toBe(1);
    expect(itemsOf([file([tour], [TRIP])], NOW, { name: "coming-up" })[0]!.days).toBe(10);
  });

  it("an invite exported to a calendar keeps its instant, and its title states no clock", () => {
    const lines = factToCalendar(call, "invites.ics", NOW).ics.split("\r\n");
    expect(lines).toContain("DTSTART:20261202T030000Z");
    expect(lines).toContain("SUMMARY:Team call");
    // A booking stated in a calendar file names an instant too.
    expect(factToCalendar(hotelInvite, "invites.ics", NOW).ics.split("\r\n")).toContain("DTSTART:20261207T150000Z");
    // A booking's clock from booking data is still written as the place's own, with no zone.
    expect(factToCalendar(flight, "booking.email", NOW).ics.split("\r\n")).toContain("DTSTART:20261206T181000");
  });

  it("the row and the words never disagree, for any invite", async () => {
    const cases: [Fact, string[]][] = [
      [call, []],
      [review, []],
      [floating, []],
      [allDay, []],
      [hotelInvite, []],
      [carInvite, []],
      [tour, [TRIP]],
      [tour, []],
    ];
    for (const [invite, tags] of cases) {
      const [row] = await rowsOf([file([invite], tags)], none, NOW);
      const where = { inTrip: tags.length > 0 };
      const shown = shownWhen(invite, where);
      expect([row!.day, row!.time], invite.label).toEqual([shown.day, shown.time]);
      if (shown.time) {
        expect(describeFact(invite, where), invite.label).toContain(` at ${shown.time}`);
      }
    }
  });
});
