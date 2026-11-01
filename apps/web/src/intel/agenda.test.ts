import { describe, expect, it } from "vitest";
import { hasAgenda, isPlanDismissed, itemsOf, planTrips, tripsOf, type AgendaFile, type PlanFile, type TripPlan } from "./agenda";
import { isDated, withExactAcceptance, type Fact } from "./facts";
import { suggestTrips } from "./trips";

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
    expect(hasAgenda([file("a", [], { tags: ["trip:lisbon-2026-11"] })])).toBe(true);
    expect(hasAgenda([file("a", [fact("x", iso(400))])])).toBe(true);
    expect(hasAgenda([file("a", [fact("x", iso(1), { confirmed: undefined })]), file("b", [], { tags: ["receipts"] })])).toBe(false);
    expect(hasAgenda([file("a", [fact("x", iso(1))], { trashed: true })])).toBe(false);
  });

  it("stops at the first dated thing, so a large library is not walked on every render", () => {
    const unread = {
      id: "later",
      trashed: false,
      get tags(): string[] {
        throw new Error("read past the first hit");
      },
      get facts(): Fact[] {
        throw new Error("read past the first hit");
      },
    } as AgendaFile;
    expect(hasAgenda([file("trip", [], { tags: ["trip:lisbon-2026-11"] }), unread])).toBe(true);
    expect(hasAgenda([file("bill", [fact("x", iso(1))]), unread])).toBe(true);
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

// The prototype's Lisbon trip, as stored facts.
let seq = 0;
const exact = (kind: Fact["kind"], value: string, label: string, extra: Partial<Fact> = {}): Fact =>
  withExactAcceptance({
    id: `${kind}:${value}:${seq++}`,
    kind,
    document: "itinerary",
    value,
    label,
    source: "jsonld",
    confidence: 1,
    ...extra,
  });
const reference = (tail: string, label: string, extra: Partial<Fact> = {}): Fact =>
  exact("identifier", tail, label, { masked: tail, ...extra });
const doc = (id: string, facts: Fact[], extra: Partial<PlanFile> = {}): PlanFile => ({
  id,
  name: `${id}.pdf`,
  tags: [],
  facts,
  trashed: false,
  ...extra,
});

const flights = (extra: Partial<Fact> = {}) => [
  exact("event", "2026-11-12", "Flight TP 236 departs SFO", { time: "18:10", ...extra }),
  exact("event", "2026-11-13", "Flight TP 236 arrives LIS", { time: "13:05", ...extra }),
  exact("event", "2026-11-16", "Flight TP 237 departs LIS", { time: "11:05", ...extra }),
  exact("event", "2026-11-16", "Flight TP 237 arrives SFO", { time: "14:20", ...extra }),
];

const lisbon = (): PlanFile[] => [
  doc("flight", [...flights(), reference("4F2K", "Confirmation number")]),
  doc("hotel", [
    exact("event", "2026-11-13", "Check-in: Casa do Rio", { document: "hotel-booking", time: "15:00" }),
    exact("event", "2026-11-16", "Check-out: Casa do Rio", { document: "hotel-booking", time: "11:00" }),
    reference("9C1D", "Confirmation number", { document: "hotel-booking" }),
  ]),
  doc("pass", [
    // Read from the barcode, which knows the flight but not its date for certain.
    {
      id: "event:pass",
      kind: "event",
      document: "boarding-pass",
      value: "2026-11-12",
      label: "Flight TP 236 departs SFO",
      source: "barcode",
      confidence: 0.6,
    },
    reference("4F2K", "Booking reference", { document: "boarding-pass", source: "barcode" }),
  ]),
  doc("museum", [exact("event", "2026-11-14", "Museu do Azulejo", { document: "event-ticket", time: "10:00" })]),
  doc("dinner", [exact("event", "2026-11-15", "Dinner: Taberna da Rua", { document: "dining", time: "20:00" })]),
  doc("eticket", [], { mailParent: "flight" }),
  doc("taxi", [
    { id: "amount:taxi", kind: "amount", document: "invoice", value: "38.00", unit: "EUR", source: "label", confidence: 0.7 },
    {
      id: "event:taxi",
      kind: "event",
      document: "invoice",
      value: "2026-11-13",
      label: "Taxi",
      source: "model",
      confidence: 0.8,
      accepted: "grounded",
    },
  ]),
];

const only = (plans: TripPlan[]): TripPlan => {
  expect(plans).toHaveLength(1);
  return plans[0]!;
};

describe("planTrips", () => {
  it("an exact journey anchors the plan and its bookings join on exact evidence", async () => {
    const plan = only(await planTrips(lisbon(), NOW));
    expect(plan.anchorId).toBe("flight");
    expect(Object.fromEntries(plan.exact)).toEqual({
      dinner: "away",
      eticket: "email",
      flight: "booking",
      hotel: "away",
      museum: "away",
      pass: "reference",
    });
    expect(plan.weak).toEqual(["taxi"]);
    expect(plan).toMatchObject({ tag: "trip:lisbon-2026-11", title: "Lisbon, Nov 2026", destination: "Lisbon" });
    expect(plan).toMatchObject({ start: "2026-11-12", end: "2026-11-16", recent: true });
  });

  it("a booking on the day of departure only asks", async () => {
    const files = lisbon().map((file) =>
      file.id === "dinner" ? doc("dinner", [exact("event", "2026-11-12", "Dinner: Airport", { document: "dining" })]) : file,
    );
    const plan = only(await planTrips(files, NOW));
    expect(plan.exact.has("dinner")).toBe(false);
    expect(plan.weak).toEqual(["dinner", "taxi"]);
  });

  it("a model-read date never anchors a trip", async () => {
    const files = lisbon().map((file) =>
      file.id === "flight"
        ? doc("flight", [...flights({ source: "model", confidence: 0.9, accepted: "grounded" }), reference("4F2K", "Confirmation number")])
        : file,
    );
    const plan = only(await planTrips(files, NOW));
    expect(plan.anchorId).toBeUndefined();
    expect(plan.exact.size).toBe(0);
    expect(plan.weak).toEqual(["dinner", "flight", "hotel", "museum", "taxi"]);
    expect(plan.dismissKeys).toEqual(["anchor:dinner"]);
  });

  it("the tag already on any member is the trip's tag", async () => {
    const files = lisbon().map((file) => (file.id === "hotel" ? { ...file, tags: ["trip:lisbon-2026-11-a"] } : file));
    expect(only(await planTrips(files, NOW)).tag).toBe("trip:lisbon-2026-11-a");
  });

  it("an unrelated reference does not join", async () => {
    const invoice = doc("invoice", [
      reference("4F2K", "Invoice number", { document: "invoice" }),
      exact("due", "2026-11-20", "Due", { document: "invoice" }),
    ]);
    const plan = only(await planTrips([...lisbon(), invoice], NOW));
    expect(plan.exact.has("invoice")).toBe(false);
    expect(plan.weak).not.toContain("invoice");
  });

  it("dismissal keys are the tag and the anchor", async () => {
    const plan = only(await planTrips(lisbon(), NOW));
    expect(plan.dismissKeys).toEqual(["trip:lisbon-2026-11", "anchor:flight"]);
    const [legacy] = await suggestTrips(lisbon(), NOW);
    expect(plan.legacyId).toBe(legacy!.id);
  });

  it("a second plan over the same files is the same plan", async () => {
    const entries = (plans: TripPlan[]) => plans.map((plan) => ({ ...plan, exact: [...plan.exact] }));
    expect(entries(await planTrips(lisbon(), NOW))).toEqual(entries(await planTrips(lisbon(), NOW)));
  });

  it("a trip long over is planned, and marked as no longer one to ask about", async () => {
    const plan = only(await planTrips(lisbon(), Date.UTC(2029, 0, 1)));
    expect(plan.anchorId).toBe("flight");
    expect(plan.recent).toBe(false);
  });
});

describe("isPlanDismissed", () => {
  it("a refusal holds through a new member, an old refusal and a new anchor", async () => {
    const plan = only(await planTrips(lisbon(), NOW));
    expect(isPlanDismissed(plan, new Set())).toBe(false);
    expect(isPlanDismissed(plan, new Set(["trip:lisbon-2026-11"]))).toBe(true);
    expect(isPlanDismissed(plan, new Set([plan.legacyId]))).toBe(true);
    // Refused while it was dates only, keyed by a file that is still in it.
    expect(isPlanDismissed(plan, new Set(["anchor:hotel"]))).toBe(true);
    expect(isPlanDismissed(plan, new Set(["anchor:elsewhere", "trip:rome-2027-05"]))).toBe(false);
  });
});
