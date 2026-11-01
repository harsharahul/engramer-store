// Rows read local days and times; pin the zone the prototype's Everyday is in.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import { planTrips } from "./agenda";
import { localDay, localTime, rowsOf, type AgendaRow, type RowContext, type RowFile } from "./agendarows";
import { withExactAcceptance, type Fact } from "./facts";

const EMAIL = "application/vnd.engram.email+json";
// Tue 8 Sep 2026, 08:40 in San Francisco.
const NOW = Date.UTC(2026, 8, 8, 15, 40);
const at = (iso: string, time: string) => new Date(`${iso}T${time}:00`).getTime();

let seq = 0;
const exact = (kind: Fact["kind"], value: string, label: string | undefined, extra: Partial<Fact> = {}): Fact =>
  withExactAcceptance({
    id: `${kind}:${value}:${seq++}`,
    kind,
    document: "itinerary",
    value,
    ...(label ? { label } : {}),
    source: "jsonld",
    confidence: 1,
    ...extra,
  });
const amount = (value: string, unit: string, extra: Partial<Fact> = {}) => exact("amount", value, undefined, { unit, ...extra });
const file = (id: string, facts: Fact[], extra: Partial<RowFile> = {}): RowFile => ({
  id,
  name: `${id}.pdf`,
  mime: "application/pdf",
  mtime: at("2026-09-01", "09:00"),
  tags: [],
  facts,
  trashed: false,
  ...extra,
});
const email = (id: string, subject: string, facts: Fact[], extra: Partial<RowFile> = {}) =>
  file(id, facts, { name: `${id}.email`, mime: EMAIL, mail: { subject, from: "Sender", date: at("2026-09-01", "09:00") }, ...extra });
const photo = (id: string, iso: string, time: string) =>
  file(id, [], { name: `${id}.jpg`, mime: "image/jpeg", mtime: at(iso, time) });

const none: RowContext = { plans: [], dismissed: new Set(), excluded: new Set() };
const titles = (rows: AgendaRow[]) => rows.map((row) => row.title);

const flights = () =>
  email("flight", "Your booking confirmation", [
    exact("event", "2026-11-12", "Flight TP 236 departs SFO", { time: "18:10" }),
    exact("event", "2026-11-13", "Flight TP 236 arrives LIS", { time: "14:05" }),
    exact("event", "2026-11-16", "Flight TP 237 departs LIS", { time: "13:20" }),
    exact("event", "2026-11-16", "Flight TP 237 arrives SFO", { time: "17:05" }),
    exact("identifier", "4F2K", "Confirmation number", { masked: "4F2K" }),
  ]);
const hotel = (extra: Partial<RowFile> = {}) =>
  email(
    "hotel",
    "Your reservation is confirmed",
    [
      exact("event", "2026-11-13", "Check-in: Casa do Rio", { document: "hotel-booking", time: "15:00" }),
      exact("event", "2026-11-16", "Check-out: Casa do Rio", { document: "hotel-booking", time: "11:00" }),
    ],
    extra,
  );

describe("rowsOf", () => {
  it("a flight is one row from its two legs", async () => {
    const rows = await rowsOf([flights()], none, NOW);
    expect(titles(rows)).toEqual(["San Francisco to Lisbon", "Lisbon to San Francisco"]);
    expect(rows[0]).toMatchObject({
      kind: "flight",
      tag: "FLIGHT",
      day: "2026-11-12",
      time: "18:10",
      endDay: "2026-11-13",
      endTime: "14:05",
      source: "EMAIL",
      sub: "Your booking confirmation",
      flight: { from: "SFO", to: "LIS", number: "TP 236", dep: "18:10", arr: "14:05", plusDays: 1 },
    });
    expect(rows[1]!.flight).toMatchObject({ number: "TP 237", plusDays: 0 });
  });

  it("a stay checks in and out on two rows", async () => {
    const rows = await rowsOf([hotel()], none, NOW);
    expect(rows.map((row) => [row.kind, row.tag, row.title, row.time])).toEqual([
      ["stay", "STAY", "Check in · Casa do Rio", "15:00"],
      ["stay", "STAY", "Check out · Casa do Rio", "11:00"],
    ]);
  });

  it("a delivery window is one row", async () => {
    const parcel = email("parcel", "Your order has shipped", [
      exact("event", "2026-09-09", "Delivery window opens", { document: "delivery", time: "10:00" }),
      exact("event", "2026-09-09", "Delivery expected by", { document: "delivery", time: "14:00" }),
    ]);
    const rows = await rowsOf([parcel], none, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "parcel", tag: "DELIVERY", title: "Your order has shipped", sub: "Between 10:00 and 14:00", time: "10:00" });
  });

  it("an event with a price is tickets, without one is booked", async () => {
    const concert = email("concert", "Your tickets", [
      exact("event", "2026-09-12", "Concert at the Greek Theatre", { document: "event-ticket", time: "19:00" }),
      exact("event", "2026-09-12", "Concert at the Greek Theatre ends", { document: "event-ticket", time: "22:00" }),
      amount("148.00", "USD"),
    ]);
    const museum = email("museum", "Your museum tickets", [
      exact("event", "2026-11-14", "Museu Nacional do Azulejo", { document: "event-ticket", time: "10:00" }),
    ]);
    const rows = await rowsOf([concert, museum], none, NOW);
    expect(rows.map((row) => [row.title, row.tag])).toEqual([
      ["Concert at the Greek Theatre", "TICKETS"],
      ["Museu Nacional do Azulejo", "BOOKED"],
    ]);
    expect(rows[0]!.amount).toEqual({ currency: "USD", value: "148.00" });
  });

  it("a bill due carries its amount", async () => {
    const bill = email("net", "Your September bill", [
      exact("due", "2026-09-10", "Payment due", { document: "invoice" }),
      amount("65.00", "USD", { label: "Amount due", document: "invoice" }),
    ]);
    const rows = await rowsOf([bill], none, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "due", tag: "DUE", title: "Payment due", amount: { currency: "USD", value: "65.00" } });
  });

  it("a receipt with a tracked total is a bill on its document date", async () => {
    const counted = file("grocer", [amount("86.40", "USD", { source: "pattern", confidence: 0.6, confirmed: true })], {
      name: "IMG_3902.jpg",
      mime: "image/jpeg",
      category: "Receipts",
      mtime: at("2026-09-07", "18:40"),
    });
    const unread = file("other", [amount("12.00", "USD", { source: "pattern", confidence: 0.6 })], {
      name: "IMG_4000.jpg",
      mime: "image/jpeg",
      category: "Receipts",
    });
    const rows = await rowsOf([counted, unread], none, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "bill",
      tag: "BILL",
      day: "2026-09-07",
      time: "18:40",
      title: "IMG_3902.jpg",
      source: "RECEIPT",
      amount: { currency: "USD", value: "86.40" },
    });
  });

  it("photos group by the local day they were taken", async () => {
    const rows = await rowsOf(
      [photo("p1", "2026-09-06", "11:05"), photo("p2", "2026-09-06", "11:00"), photo("p3", "2026-09-06", "16:00"), photo("p4", "2026-09-07", "09:00")],
      none,
      NOW,
    );
    expect(rows.map((row) => [row.kind, row.day, row.title, row.time, row.fileIds])).toEqual([
      ["photos", "2026-09-06", "3 photos", "11:00", ["p2", "p1", "p3"]],
      ["photos", "2026-09-07", "1 photo", "09:00", ["p4"]],
    ]);
    expect(rows[0]!.source).toBe("PHOTOS");
  });

  it("an untracked date asks, a tracked one does not", async () => {
    const dmv = file("dmv", [{ id: "due:dmv", kind: "due", document: "vehicle-registration", value: "2026-09-30", source: "label", confidence: 0.7 }]);
    const net = email("net", "Your September bill", [exact("due", "2026-09-10", "Payment due", { document: "invoice" })]);
    const rows = await rowsOf([dmv, net], none, NOW);
    expect(rows.map((row) => [row.title, row.ask ?? false])).toEqual([
      ["Payment due", false],
      ["Vehicle registration due", true],
    ]);
  });

  it("a date-only document in a journey is a weak trip row, a tagged one is exact", async () => {
    const taxi = file("taxi", [
      { id: "event:taxi", kind: "event", document: "invoice", value: "2026-11-13", label: "Taxi", source: "model", confidence: 0.8, accepted: "grounded" },
    ]);
    const files = [flights(), hotel({ tags: ["trip:lisbon-2026-11"] }), taxi];
    const plans = await planTrips(files, NOW);
    const rows = await rowsOf(files, { ...none, plans }, NOW);
    const trip = (id: string) => rows.find((row) => row.fileIds[0] === id)!.trip;
    expect(trip("taxi")).toEqual({ tag: "trip:lisbon-2026-11", title: "Lisbon, Nov 2026", name: "Lisbon", evidence: "weak" });
    expect(trip("hotel")).toMatchObject({ evidence: "exact", name: "Lisbon" });
    const kept = await rowsOf(files, { ...none, plans, excluded: new Set(["trip:lisbon-2026-11|taxi"]) }, NOW);
    expect(kept.find((row) => row.fileIds[0] === "taxi")!.trip).toBeUndefined();
  });

  it("a receipt dated inside a trip is a weak trip row", async () => {
    const lunch = file("lunch", [amount("38.60", "EUR", { source: "user", confirmed: true })], {
      name: "IMG_4161.jpg",
      mime: "image/jpeg",
      category: "Receipts",
      mtime: at("2026-11-14", "13:30"),
    });
    const files = [flights(), hotel(), lunch];
    const rows = await rowsOf(files, { ...none, plans: await planTrips(files, NOW) }, NOW);
    expect(rows.find((row) => row.kind === "bill")!.trip).toMatchObject({ evidence: "weak", name: "Lisbon" });
  });

  it("a date-only plan is one trip proposal until refused", async () => {
    const stay = email("chicago-hotel", "Your stay in Chicago", [
      exact("event", "2026-12-18", "Check-in: The Loop Hotel", { document: "hotel-booking" }),
      exact("event", "2026-12-21", "Check-out: The Loop Hotel", { document: "hotel-booking" }),
    ]);
    const invite = email("conference", "Conference invitation", [exact("event", "2026-12-19", "Data conference", { source: "ics", document: "other" })]);
    const files = [stay, invite];
    const plans = await planTrips(files, NOW, { extraPlaces: new Map([["chicago-hotel", new Set(["Chicago"])]]) });
    const rows = await rowsOf(files, { ...none, plans }, NOW);
    const proposal = rows.find((row) => row.kind === "trip")!;
    expect(proposal).toMatchObject({
      tag: "TRIP?",
      day: "2026-12-18",
      title: "Chicago, 18-21 Dec?",
      sub: "2 documents share these dates. Only the dates match, so Engram asks first.",
      source: "EMAIL",
    });
    const refused = await rowsOf(files, { ...none, plans, dismissed: new Set([plans[0]!.dismissKeys[0]!]) }, NOW);
    expect(refused.some((row) => row.kind === "trip")).toBe(false);
  });

  it("rows sort by day then time and past rows say so", async () => {
    const files = [
      email("dinner", "Your table is booked", [exact("event", "2026-09-08", "Table at Cedar & Salt", { document: "dining", time: "19:30" })]),
      email("allday", "Reminder", [exact("event", "2026-09-08", "Street cleaning", { document: "other" })]),
      email("lunch", "Lunch", [exact("event", "2026-09-08", "Lunch with Sam", { document: "dining", time: "08:00" })]),
      email("rent", "Rent", [exact("event", "2026-09-07", "Rent reminder", { document: "other", time: "09:00" })]),
    ];
    const rows = await rowsOf(files, none, NOW);
    expect(rows.map((row) => [row.title, row.past])).toEqual([
      ["Rent reminder", true],
      ["Street cleaning", false],
      ["Lunch with Sam", true],
      ["Table at Cedar & Salt", false],
    ]);
  });

  it("twenty thousand files make rows in under half a second", async () => {
    const files: RowFile[] = [];
    for (let i = 0; i < 15_000; i++) {
      files.push(photo(`p${i}`, localDay(at("2024-01-01", "12:00") + i * 3_600_000 * 2), "12:00"));
    }
    for (let i = 0; i < 5_000; i++) {
      const due = localDay(at("2024-01-01", "12:00") + i * 86_400_000);
      files.push(email(`b${i}`, "Bill", [exact("due", due, "Payment due", { document: "invoice" }), amount("10.00", "USD")]));
    }
    const started = performance.now();
    const rows = await rowsOf(files, none, NOW);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rows.length).toBeGreaterThan(5_000);
  });

  it("local days and times are the device's", () => {
    expect(localDay(NOW)).toBe("2026-09-08");
    expect(localTime(NOW)).toBe("08:40");
  });
});
