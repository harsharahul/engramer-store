import { describe, expect, it } from "vitest";
import { hasAgenda, itemsOf, tripsOf, type AgendaFile } from "./agenda";
import { isDated, type Fact } from "./facts";

const NOW = Date.UTC(2026, 8, 10, 12);
const DAY = 86_400_000;
const iso = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);

const fact = (id: string, value: string, extra: Partial<Fact> = {}): Fact => ({
  id,
  kind: "due",
  document: "other",
  value,
  source: "label",
  confidence: 0.7,
  confirmed: true,
  ...extra,
});

const file = (id: string, facts: Fact[], extra: Partial<AgendaFile> = {}): AgendaFile => ({
  id,
  tags: [],
  facts,
  trashed: false,
  ...extra,
});

const ids = (files: AgendaFile[], window: Parameters<typeof itemsOf>[2]) =>
  itemsOf(files, NOW, window).map((item) => item.fact.id);

describe("itemsOf", () => {
  it("the coming-up window keeps what the bell kept, edges included", () => {
    const files = [file("a", [fact("past30", iso(-30)), fact("past29", iso(-29)), fact("ahead119", iso(119)), fact("ahead120", iso(120))])];
    expect(ids(files, { name: "coming-up" })).toEqual(["past29", "ahead119"]);
    expect(ids(files, { name: "all" })).toEqual(["past30", "past29", "ahead119", "ahead120"]);
  });

  it("only tracked dates count", () => {
    const unconfirmed = { confirmed: undefined };
    const files = [
      file("a", [
        fact("owner", iso(1)),
        fact("exact", iso(2), { ...unconfirmed, accepted: "exact", source: "jsonld", confidence: 1 }),
        fact("grounded", iso(3), { ...unconfirmed, accepted: "grounded", source: "model" }),
        fact("offered", iso(4), unconfirmed),
        fact("dismissed", iso(5), { dismissed: true }),
        fact("loser", iso(6), { ...unconfirmed, disputed: "due:other" }),
        fact("amount", "65.00", { kind: "amount", unit: "USD" }),
        fact("reference", "4F2K", { kind: "identifier" }),
      ]),
    ];
    expect(ids(files, { name: "all" })).toEqual(["owner", "exact", "grounded"]);
  });

  it("a trashed file's dates count nowhere", () => {
    expect(ids([file("a", [fact("gone", iso(2))], { trashed: true })], { name: "all" })).toEqual([]);
  });

  it("rows are ordered by day, then time, then file", () => {
    const files = [
      file("b", [fact("b-late", iso(1), { kind: "event", time: "19:30" }), fact("b-noon", iso(1), { kind: "event", time: "12:00" })]),
      file("a", [fact("a-allday", iso(1)), fact("a-next", iso(2))]),
      file("c", [fact("c-allday", iso(1))]),
    ];
    expect(ids(files, { name: "all" })).toEqual(["a-allday", "c-allday", "b-noon", "b-late", "a-next"]);
  });

  it("says how many days away each row is", () => {
    expect(itemsOf([file("a", [fact("x", iso(3))])], NOW, { name: "all" })[0]).toMatchObject({ days: 3 });
  });
});

describe("tripsOf", () => {
  const LISBON = "trip:lisbon-2026-11";
  const ROME = "trip:rome-2026-12";
  const event = (id: string, value: string) => fact(id, value, { kind: "event", document: "itinerary" });

  it("gathers each tag's members and spans their events", () => {
    const trips = tripsOf([
      file("out", [event("dep", "2026-11-12")], { tags: [LISBON] }),
      file("stay", [event("in", "2026-11-13"), event("outday", "2026-11-16")], { tags: [LISBON, "receipts"] }),
      file("bill", [fact("due", "2026-11-30")], { tags: [LISBON] }),
      file("other", [event("x", "2026-10-01")]),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ tag: LISBON, title: "Lisbon, Nov 2026", start: "2026-11-12", end: "2026-11-16" });
    expect(trips[0]!.members.map((member) => member.id)).toEqual(["out", "stay", "bill"]);
  });

  it("a file in two trips extends both spans", () => {
    const trips = tripsOf([
      file("both", [event("e", "2026-11-20")], { tags: [ROME, LISBON] }),
      file("lisbon", [event("l", "2026-11-12")], { tags: [LISBON] }),
      file("rome", [event("r", "2026-12-02")], { tags: [ROME] }),
    ]);
    expect(trips.map(({ tag, start, end }) => ({ tag, start, end }))).toEqual([
      { tag: LISBON, start: "2026-11-12", end: "2026-11-20" },
      { tag: ROME, start: "2026-11-20", end: "2026-12-02" },
    ]);
  });

  it("a trip without tracked events has no span", () => {
    const [trip] = tripsOf([file("pass", [event("offered", "2026-11-12")].map((f) => ({ ...f, confirmed: undefined })), { tags: [LISBON] })]);
    expect(trip).toMatchObject({ tag: LISBON });
    expect(trip!.start).toBeUndefined();
    expect(trip!.end).toBeUndefined();
  });

  it("a trashed member is not a member", () => {
    const trips = tripsOf([
      file("gone", [event("g", "2026-11-01")], { tags: [LISBON], trashed: true }),
      file("kept", [event("k", "2026-11-12")], { tags: [LISBON] }),
    ]);
    expect(trips[0]!.members.map((member) => member.id)).toEqual(["kept"]);
    expect(trips[0]!.start).toBe("2026-11-12");
    expect(tripsOf([file("gone", [], { tags: [ROME], trashed: true })])).toEqual([]);
  });
});

describe("hasAgenda", () => {
  it("is true for a trip tag or a tracked date, false otherwise", () => {
    expect(hasAgenda([file("a", [], { tags: ["trip:lisbon-2026-11"] })], NOW)).toBe(true);
    expect(hasAgenda([file("a", [fact("x", iso(400))])], NOW)).toBe(true);
    expect(hasAgenda([file("a", [fact("x", iso(1), { confirmed: undefined })]), file("b", [], { tags: ["receipts"] })], NOW)).toBe(false);
    expect(hasAgenda([file("a", [fact("x", iso(1))], { trashed: true })], NOW)).toBe(false);
  });
});

describe("isDated", () => {
  it("knows the dated kinds", () => {
    for (const kind of ["expiry", "due", "event", "dated"] as const) {
      expect(isDated({ kind })).toBe(true);
    }
    for (const kind of ["issued", "period", "amount", "identifier"] as const) {
      expect(isDated({ kind })).toBe(false);
    }
  });
});
