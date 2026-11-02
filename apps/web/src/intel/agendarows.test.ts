// Rows read local days and times; pin the zone of the ordinary day below.
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

const none: RowContext = { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true };
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
    const files = [flights(), hotel({ tags: ["trip:lisbon-2026-11"] }), lunch];
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

  it("an ordinary week of dinners, deliveries and a concert is not a trip question", async () => {
    const files = [
      email("dinner", "Your table is booked", [exact("event", "2026-09-08", "Table at Cedar & Salt", { document: "dining", time: "19:30" })]),
      email("parcel", "Your order has shipped", [exact("event", "2026-09-09", "Delivery window opens", { document: "delivery", time: "10:00" })]),
      email("concert", "Your tickets", [exact("event", "2026-09-12", "Concert at the Greek Theatre", { document: "event-ticket", time: "19:00" })]),
    ];
    const plans = await planTrips(files, NOW);
    expect(plans).toHaveLength(1);
    const rows = await rowsOf(files, { ...none, plans }, NOW);
    expect(rows.some((row) => row.kind === "trip")).toBe(false);
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

  it("an invoice whose due date still asks, or was refused, is not a paid bill", async () => {
    const asking = email("statement", "Your September statement", [
      { id: "due:statement", kind: "due", document: "invoice", value: "2026-09-25", source: "label", confidence: 0.7 },
      amount("65.00", "USD", { label: "Amount due", document: "invoice" }),
    ]);
    const refused = email("refused", "Your bill", [
      { id: "due:refused", kind: "due", document: "invoice", value: "2026-09-26", source: "label", confidence: 0.7, dismissed: true },
      amount("40.00", "USD", { label: "Amount due", document: "invoice" }),
    ]);
    const rows = await rowsOf([asking, refused], none, NOW);
    expect(rows.map((row) => [row.kind, row.ask ?? false])).toEqual([["due", true]]);
  });

  it("a round trip under one designator keeps both journeys", async () => {
    const bus = email("bus", "Your bus tickets", [
      exact("event", "2026-10-01", "Bus FlixBus departs Berlin ZOB", { time: "08:00" }),
      exact("event", "2026-10-01", "Bus FlixBus arrives Prague", { time: "12:30" }),
      exact("event", "2026-10-05", "Bus FlixBus departs Prague", { time: "15:00" }),
      exact("event", "2026-10-05", "Bus FlixBus arrives Berlin ZOB", { time: "19:30" }),
    ]);
    const rows = await rowsOf([bus], none, NOW);
    expect(titles(rows)).toEqual(["Berlin ZOB to Prague", "Prague to Berlin ZOB"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.map((row) => row.flight?.number)).toEqual(["FlixBus", "FlixBus"]);
  });

  it("a date-only document is asked about only for a trip that exists, is recent and was not refused", async () => {
    const taxi = file("taxi", [
      { id: "event:taxi", kind: "event", document: "invoice", value: "2026-11-13", label: "Taxi", source: "model", confidence: 0.8, accepted: "grounded" },
    ]);
    const untagged = [flights(), hotel(), taxi];
    const plans = await planTrips(untagged, NOW);
    const weak = (rows: AgendaRow[]) => rows.find((row) => row.fileIds[0] === "taxi")!.trip;
    expect(weak(await rowsOf(untagged, { ...none, plans }, NOW))).toBeUndefined();
    const tagged = [flights(), hotel({ tags: ["trip:lisbon-2026-11"] }), taxi];
    const taggedPlans = await planTrips(tagged, NOW);
    const refused = new Set(taggedPlans[0]!.dismissKeys);
    expect(weak(await rowsOf(tagged, { ...none, plans: taggedPlans, dismissed: refused }, NOW))).toBeUndefined();
    const later = Date.UTC(2027, 5, 1);
    expect(weak(await rowsOf(tagged, { ...none, plans: await planTrips(tagged, later) }, later))).toBeUndefined();
  });

  it("with automatic trips off, a booked journey is one proposal", async () => {
    const files = [flights(), hotel()];
    const plans = await planTrips(files, NOW);
    const off = await rowsOf(files, { ...none, plans, assembling: false }, NOW);
    expect(off.filter((row) => row.kind === "trip").map((row) => [row.title, row.fileIds])).toEqual([
      ["Lisbon, 12-16 Nov?", ["flight", "hotel"]],
    ]);
    expect((await rowsOf(files, { ...none, plans }, NOW)).some((row) => row.kind === "trip")).toBe(false);
  });

  it("an asking flight row names the facts to confirm", async () => {
    const read = (id: string, value: string, label: string, time: string): Fact => ({
      id,
      kind: "event",
      document: "itinerary",
      value,
      label,
      time,
      source: "model",
      confidence: 0.8,
    });
    const leg = email("leg", "Itinerary", [
      read("out", "2026-11-12", "Flight TP 236 departs SFO", "18:10"),
      read("in", "2026-11-13", "Flight TP 236 arrives LIS", "14:05"),
    ]);
    const [row] = await rowsOf([leg], none, NOW);
    expect(row).toMatchObject({ kind: "flight", ask: true, factIds: ["out", "in"] });
  });

  it("an email and its receipt are one bill, dated and named by the email", async () => {
    const receiptEmail = email("tax-mail", "Your receipt", [amount("6.00", "EUR", { source: "user", confirmed: true })], {
      mail: { subject: "Your receipt", from: "Casa do Rio", date: at("2026-09-02", "10:00") },
    });
    const pdf = file("tax-pdf", [amount("6.00", "EUR", { source: "user", confirmed: true })], { mailParent: "tax-mail", mtime: at("2026-09-05", "12:00") });
    const lonePdf = file("lone-pdf", [amount("9.00", "EUR", { source: "user", confirmed: true })], { mailParent: "lone-mail", mtime: at("2026-09-06", "12:00") });
    const loneEmail = email("lone-mail", "Your invoice", [], { mail: { subject: "Your invoice", date: at("2026-09-03", "08:00") } });
    const rows = await rowsOf([receiptEmail, pdf, lonePdf, loneEmail], none, NOW);
    expect(rows.map((row) => [row.kind, row.title, row.day, row.amount?.value])).toEqual([
      ["bill", "Your receipt", "2026-09-02", "6.00"],
      ["bill", "Your invoice", "2026-09-03", "9.00"],
    ]);
  });

  it("a paid booking is a bill as well as its flights", async () => {
    const paid = email("paid", "Your booking confirmation", [...flights().facts, amount("1184.00", "USD", { source: "user", confirmed: true })], {
      mail: { subject: "Your booking confirmation", date: at("2026-09-18", "20:14") },
    });
    const rows = await rowsOf([paid], none, NOW);
    expect(rows.map((row) => [row.kind, row.day])).toEqual([
      ["bill", "2026-09-18"],
      ["flight", "2026-11-12"],
      ["flight", "2026-11-16"],
    ]);
    expect(rows[0]!.amount).toEqual({ currency: "USD", value: "1184.00" });
  });

  it("a delivery window that only opens reads From", async () => {
    const opens = email("opens", "Out for delivery", [exact("event", "2026-09-09", "Delivery window opens", { document: "delivery", time: "10:00" })]);
    const by = email("by", "Arriving today", [exact("event", "2026-09-10", "Delivery expected by", { document: "delivery", time: "14:00" })]);
    const rows = await rowsOf([opens, by], none, NOW);
    expect(rows.map((row) => row.sub)).toEqual(["From 10:00", "By 14:00"]);
  });

  it("local days and times are the device's", () => {
    expect(localDay(NOW)).toBe("2026-09-08");
    expect(localTime(NOW)).toBe("08:40");
  });
});

describe("rows read what each date is", () => {
  it("a confirmed stay the model read is a stay row", async () => {
    const said = (value: string, time: string, role: "check-in" | "check-out", label: string): Fact => ({
      id: `event:${value} ${label.toLowerCase()} ${time}`,
      kind: "event",
      document: "hotel-booking",
      value,
      time,
      label,
      source: "model",
      confidence: 0.45,
      confirmed: true,
      subject: { role, place: "Casa Azulejo" },
    });
    const guesthouse = email("guesthouse", "Re: your room", [
      said("2026-11-13", "15:00", "check-in", "Room ready"),
      said("2026-11-16", "11:00", "check-out", "Key at reception"),
    ]);
    const rows = await rowsOf([guesthouse], none, NOW);
    expect(rows.filter((row) => row.kind === "stay").map((row) => row.title)).toEqual(["Check in · Casa Azulejo", "Check out · Casa Azulejo"]);
  });
});

describe("rows carry real instants", () => {
  it("a flight row starts and ends at the instants of its own airports", async () => {
    const [out] = await rowsOf([flights()], none, NOW);
    expect(out!.at).toBe(Date.UTC(2026, 10, 13, 2, 10)); // 18:10 in San Francisco
    expect(out!.endAt).toBe(Date.UTC(2026, 10, 13, 14, 5)); // 14:05 in Lisbon
  });

  it("a hotel in a trip takes the trip's destination zone", async () => {
    const rows = await rowsOf([hotel({ tags: ["trip:lisbon-2026-11"] })], none, NOW);
    expect(rows.map((row) => row.at)).toEqual([Date.UTC(2026, 10, 13, 15, 0), Date.UTC(2026, 10, 16, 11, 0)]);
  });
});
