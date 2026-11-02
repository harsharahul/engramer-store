// An ordinary day: a Tuesday morning in San Francisco.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import type { Trip } from "./agenda";
import { rowsOf, type AgendaRow, type RowFile } from "./agendarows";
import type { Fact } from "./facts";
import { deviceZone, instantOf } from "./instants";
import { dayLabel, durationLabel, everydayOf, money, skyOf } from "./everyday";

const NOW = Date.UTC(2026, 8, 8, 15, 40); // Tue 8 Sep 2026, 08:40 PDT

const row = (id: string, kind: AgendaRow["kind"], day: string, time: string | undefined, extra: Partial<AgendaRow> = {}): AgendaRow => ({
  id,
  kind,
  tag: kind.toUpperCase(),
  day,
  at: instantOf(day, time, deviceZone()),
  ...(time ? { time } : {}),
  title: id,
  source: "EMAIL",
  fileIds: [id],
  past: false,
  ...extra,
});
const usd = (value: string) => ({ currency: "USD", value });

const september = (): AgendaRow[] => [
  row("rent", "bill", "2026-09-01", "09:00", { amount: usd("2400.00"), past: true }),
  row("desk", "parcel", "2026-09-03", "14:20", { past: true }),
  row("photos:2026-09-06", "photos", "2026-09-06", "11:00", { past: true, title: "14 photos" }),
  row("groceries", "bill", "2026-09-07", "18:40", { amount: usd("86.40"), past: true }),
  row("dinner", "event", "2026-09-08", "19:30"),
  row("headphones", "parcel", "2026-09-09", "10:00"),
  row("internet", "due", "2026-09-10", undefined, { amount: usd("65.00") }),
  row("concert", "event", "2026-09-12", "19:00", { amount: usd("148.00") }),
  row("registration", "due", "2026-09-30", undefined, { amount: usd("212.00"), ask: true, factIds: ["due:registration"] }),
  row("power", "due", "2026-11-20", undefined, { amount: usd("84.20") }),
  row("insurance", "due", "2026-12-01", undefined, { ask: true, factIds: ["due:insurance"] }),
];

describe("everydayOf", () => {
  it("the Everyday cards read an ordinary September", () => {
    const day = everydayOf(september(), [], NOW);
    expect(day.today.map((r) => r.id)).toEqual(["dinner"]);
    expect(day.laterToday).toBe(1);
    expect(day.week.map((r) => r.id)).toEqual(["headphones", "internet", "concert"]);
    expect(day.needsYes?.id).toBe("registration");
    expect(day.month).toEqual({
      name: "September",
      paid: [usd("2486.40")],
      due: [usd("65.00")],
      receipts: 2,
      bills: 1,
    });
    expect(day.nextTrip).toBeUndefined();
  });

  it("a date more than 60 days out does not ask yet", () => {
    const day = everydayOf(september().filter((r) => r.id !== "registration"), [], NOW);
    expect(day.needsYes).toBeUndefined();
  });

  it("on this day finds last year's photos, named for their trip", () => {
    const photos = row("photos:2025-09-08", "photos", "2025-09-08", "10:00", { past: true, title: "31 photos", fileIds: ["a", "b", "c"] });
    const trip: Trip = { tag: "trip:big-sur-2025-09", title: "Big Sur, Sep 2025", members: [{ id: "a" }, { id: "b" }] as Trip["members"], start: "2025-09-07", end: "2025-09-09" };
    const day = everydayOf([...september(), photos], [trip], NOW);
    expect(day.onThisDay).toEqual({ year: 2025, yearsAgo: 1, title: "Big Sur · 31 photos", fileIds: ["a", "b", "c"] });
    expect(everydayOf([...september(), photos], [], NOW).onThisDay?.title).toBe("31 photos");
  });

  it("the next trip is named with the days until it starts", () => {
    const trip = { tag: "trip:lisbon-2026-11", title: "Lisbon, Nov 2026", members: [], start: "2026-11-12", end: "2026-11-16" } as Trip;
    expect(everydayOf(september(), [trip], NOW).nextTrip).toEqual({ title: "Lisbon, Nov 2026", days: 65 });
  });
});

describe("the cards from the library", () => {
  it("money reads what was paid and what is due, never an invoice still asking", async () => {
    const mail = (id: string, subject: string, facts: Fact[], date: number): RowFile => ({
      id,
      name: `${id}.email`,
      mime: "application/vnd.engram.email+json",
      mtime: date,
      tags: [],
      facts,
      trashed: false,
      mail: { subject, date },
    });
    const amount = (id: string, value: string): Fact => ({ id, kind: "amount", document: "invoice", value, unit: "USD", label: "Amount due", source: "jsonld", confidence: 1, accepted: "exact" });
    const files = [
      mail("rent", "Payment received", [amount("rent-amt", "2400.00")], Date.UTC(2026, 8, 1, 16)),
      mail("net", "Your September bill", [{ id: "net-due", kind: "due", document: "invoice", value: "2026-09-10", label: "Payment due", source: "jsonld", confidence: 1, accepted: "exact" }, amount("net-amt", "65.00")], Date.UTC(2026, 8, 1, 14)),
      mail("statement", "Your statement", [{ id: "st-due", kind: "due", document: "invoice", value: "2026-09-25", source: "label", confidence: 0.7 }, amount("st-amt", "80.00")], Date.UTC(2026, 8, 2, 14)),
    ];
    const rows = await rowsOf(files, { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true }, NOW);
    const day = everydayOf(rows, [], NOW);
    expect(day.month).toEqual({ name: "September", paid: [usd("2400.00")], due: [usd("65.00")], receipts: 1, bills: 1 });
    expect(day.needsYes?.title).toBe("Invoice due");
  });
});

describe("the words the cards use", () => {
  it("durations, money and day labels read as designed", () => {
    expect(durationLabel(39_000_000)).toBe("10 h 50 m");
    expect(durationLabel(115_200_000)).toBe("1 d 8 h");
    expect(durationLabel(240_000)).toBe("4 min");
    expect(durationLabel(-5)).toBe("0 min");
    expect(money({ currency: "EUR", value: "1184" })).toBe("EUR 1,184.00");
    expect(dayLabel("2026-09-08")).toBe("Tue 8 Sep");
  });

  it("the sky follows the hour", () => {
    expect([4, 6, 8, 16, 17, 21].map(skyOf)).toEqual(["night", "dawn", "day", "day", "dusk", "night"]);
  });
});
