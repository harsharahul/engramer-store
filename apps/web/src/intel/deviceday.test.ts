// A day is the device's day. Pin a zone well behind UTC, where the evening
// is already tomorrow by the UTC clock.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import { dueNotices } from "../notices";
import { daysUntil } from "./dates";
import { whenLabel } from "./describe";
import type { Fact } from "./facts";

// 18:00 on Thu 19 Nov 2026 in San Francisco: 02:00 on the 20th in UTC.
const EVENING = new Date("2026-11-19T18:00:00-08:00").getTime();
// 08:00 the same morning: still the 19th everywhere west of Asia.
const MORNING = new Date("2026-11-19T08:00:00-08:00").getTime();

describe("days are counted from the device's own day", () => {
  it("tomorrow is still tomorrow in the evening", () => {
    expect(daysUntil("2026-11-20", EVENING)).toBe(1);
    expect(daysUntil("2026-11-20", MORNING)).toBe(1);
    expect(whenLabel("2026-11-20", EVENING)).toBe(whenLabel("2026-11-20", MORNING));
  });

  it("something due today is not overdue until the day is over", () => {
    expect(daysUntil("2026-11-19", EVENING)).toBe(0);
    expect(daysUntil("2026-11-18", EVENING)).toBe(-1);
    expect(whenLabel("2026-11-19", EVENING)).toBe(whenLabel("2026-11-19", MORNING));
  });

  it("the bell calls a bill due today soon, and overdue only the day after", () => {
    const due: Fact = { id: "due:2026-11-19", kind: "due", document: "invoice", value: "2026-11-19", source: "label", confidence: 0.7, confirmed: true };
    const bill = [{ id: "bill", name: "water-bill.pdf", trashed: false, tags: [], facts: [due], createdAt: MORNING }];
    const said = (now: number) => dueNotices(bill, now).filter((notice) => notice.key === "fact:bill:due:2026-11-19").map((notice) => notice.severity);
    expect(said(EVENING)).toEqual(["soon"]);
    expect(said(new Date("2026-11-20T08:00:00-08:00").getTime())).toEqual(["overdue"]);
  });

  it("counts whole days across a clock change", () => {
    // Daylight time ended on 1 Nov 2026: that day had 25 hours.
    expect(daysUntil("2026-11-02", new Date("2026-10-31T23:30:00-07:00").getTime())).toBe(2);
    expect(daysUntil("2027-03-15", new Date("2027-03-13T23:30:00-08:00").getTime())).toBe(2);
  });
});
