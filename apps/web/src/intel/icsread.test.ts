import { describe, expect, it } from "vitest";
import { icsFacts } from "./icsread";
import { scanForFacts } from "./scan";

// Synthetic invites: invented events, places and dates.
const calendar = (...lines: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Synthetic//EN", ...lines, "END:VCALENDAR"].join("\r\n");

describe("icsFacts", () => {
  it("reads a timed event with its zone", () => {
    const facts = icsFacts(
      calendar(
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:evt-1@example.com",
        "SUMMARY:Harbor Lights Concert",
        "DTSTART;TZID=Europe/Lisbon:20270512T193000",
        "DTEND;TZID=Europe/Lisbon:20270512T220000",
        "LOCATION:Example Hall\\, Lisbon",
        "END:VEVENT",
      ),
    );
    expect(facts[0]).toMatchObject({
      kind: "event",
      value: "2027-05-12",
      time: "19:30",
      zone: "Europe/Lisbon",
      label: "Harbor Lights Concert",
      source: "ics",
      confidence: 1,
    });
    expect(facts[1]).toMatchObject({ label: "Harbor Lights Concert ends", time: "22:00" });
  });

  it("keeps a UTC time as UTC", () => {
    const facts = icsFacts(calendar("BEGIN:VEVENT", "SUMMARY:Call", "DTSTART:20270512T080000Z", "END:VEVENT"));
    expect(facts[0]).toMatchObject({ value: "2027-05-12", time: "08:00", zone: "UTC" });
  });

  it("reads an all-day event", () => {
    const facts = icsFacts(
      calendar(
        "BEGIN:VEVENT",
        "SUMMARY:Car registration renewal",
        "DTSTART;VALUE=DATE:20270930",
        "DTEND;VALUE=DATE:20271001",
        "END:VEVENT",
      ),
    );
    // A whole-day event ends the next day by the standard's own rule; that is
    // not a second date worth tracking.
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ value: "2027-09-30", label: "Car registration renewal" });
    expect(facts[0]).not.toHaveProperty("time");
  });

  it("unfolds a long summary", () => {
    const facts = icsFacts(
      calendar("BEGIN:VEVENT", "SUMMARY:Quarterly review with the", "  facilities team", "DTSTART:20270512T080000Z", "END:VEVENT"),
    );
    expect(facts[0]!.label).toBe("Quarterly review with the facilities team");
  });

  it("a cancelled invite adds nothing", () => {
    expect(
      icsFacts(calendar("METHOD:CANCEL", "BEGIN:VEVENT", "SUMMARY:Call", "DTSTART:20270512T080000Z", "END:VEVENT")),
    ).toEqual([]);
  });

  it("names a ticketed event as a ticket", () => {
    const facts = icsFacts(
      calendar("BEGIN:VEVENT", "SUMMARY:Concert tickets: Harbor Lights", "DTSTART:20270512T193000Z", "END:VEVENT"),
    );
    expect(facts[0]!.document).toBe("event-ticket");
  });

  it("ignores text that is not a calendar", () => {
    expect(icsFacts("hello")).toEqual([]);
  });
});

describe("invites through the scanner", () => {
  it("an invite attached to mail is read when stored", async () => {
    const raw = calendar("BEGIN:VEVENT", "SUMMARY:Dinner at Casa Verde", "DTSTART:20270513T190000Z", "END:VEVENT");
    const out = await scanForFacts({ name: "invite.ics", mime: "text/calendar", raw });
    expect(out.facts).toEqual([
      expect.objectContaining({ kind: "event", value: "2027-05-13", time: "19:00", source: "ics" }),
    ]);
  });
});
