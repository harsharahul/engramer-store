// A calendar invite's time is an instant, shown in the device's own zone on
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

const fact = (over: Partial<Fact>): Fact =>
  withExactAcceptance({ id: `event:${over.value} ${over.label}`, kind: "event", document: "other", value: "2026-12-02", label: "Team call", source: "ics", confidence: 1, ...over });

// 03:00 UTC on Wed 2 Dec is 19:00 on Tue 1 Dec in San Francisco.
const call = fact({ value: "2026-12-02", time: "03:00", zone: "UTC", label: "Team call" });
// 17:00 in New York is 14:00 in San Francisco.
const review = fact({ value: "2026-12-03", time: "17:00", zone: "America/New_York", label: "Design review" });
const floating = fact({ value: "2026-12-04", time: "09:00", label: "Dentist" });
const allDay = fact({ value: "2026-12-05", label: "Conference" });
const flight = fact({ value: "2026-12-06", time: "18:10", zone: "-08:00", label: "Flight TP 236 departs SFO", source: "jsonld", document: "itinerary" });
const hotel = fact({ value: "2026-12-07", time: "15:00", zone: "UTC", label: "Check-in: Casa do Rio", source: "jsonld", document: "hotel-booking" });

const file = (facts: Fact[]): RowFile & { createdAt: number } => ({
  id: "invites",
  name: "invites.ics",
  mime: "text/calendar",
  mtime: NOW,
  createdAt: NOW,
  tags: [],
  facts,
  trashed: false,
});

describe("the day and time a fact is shown at", () => {
  it("an invite's instant is shown in the device's zone", () => {
    expect(shownWhen(call)).toEqual({ day: "2026-12-01", time: "19:00" });
    expect(shownWhen(review)).toEqual({ day: "2026-12-03", time: "14:00" });
  });

  it("an invite with no zone, or with no time, is shown as written", () => {
    expect(shownWhen(floating)).toEqual({ day: "2026-12-04", time: "09:00" });
    expect(shownWhen(allDay)).toEqual({ day: "2026-12-05" });
  });

  it("a booking keeps the clock of its place", () => {
    expect(shownWhen(flight)).toEqual({ day: "2026-12-06", time: "18:10" });
    expect(shownWhen(hotel)).toEqual({ day: "2026-12-07", time: "15:00" });
  });

  it("an invite in a zone this device cannot read is shown as written", () => {
    expect(shownWhen(fact({ value: "2026-12-04", time: "09:00", zone: "Customized Time Zone" }))).toEqual({ day: "2026-12-04", time: "09:00" });
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

  it("the words in the details pane, the bell and a notification say the same", () => {
    expect(describeFact(call)).toBe("Team call, 1 December 2026 at 19:00");
    expect(describeFact(review)).toBe("Design review, 3 December 2026 at 14:00");
    expect(describeFact(hotel)).toBe("Check-in: Casa do Rio, 7 December 2026 at 15:00");
    const notice = dueNotices([file([call])], NOW).find((entry) => entry.key.startsWith("fact:"));
    expect(notice?.title).toBe("Team call, 1 December 2026 at 19:00");
  });

  it("the days to an invite are counted to the device's day", () => {
    const [item] = itemsOf([file([call])], NOW, { name: "coming-up" });
    expect(item!.days).toBe(1);
  });

  it("an invite exported to a calendar keeps its instant", () => {
    const lines = factToCalendar(call, "invites.ics", NOW).ics.split("\r\n");
    expect(lines).toContain("DTSTART:20261202T030000Z");
    // A booking's clock is still written as the place's own, with no zone.
    expect(factToCalendar(flight, "booking.email", NOW).ics.split("\r\n")).toContain("DTSTART:20261206T181000");
  });

  it("the row and the words never disagree, for any invite", async () => {
    for (const invite of [call, review, floating, allDay]) {
      const [row] = await rowsOf([file([invite])], none, NOW);
      const shown = shownWhen(invite);
      expect([row!.day, row!.time]).toEqual([shown.day, shown.time]);
      if (shown.time) {
        expect(describeFact(invite)).toContain(` at ${shown.time}`);
      }
    }
  });
});
