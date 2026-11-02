import { describe, expect, it } from "vitest";
import { planTrips, tripsOf, type TripPlan } from "./agenda";
import { rowsOf, type AgendaRow, type RowContext, type RowFile } from "./agendarows";
import { withExactAcceptance, type Fact } from "./facts";
import { comingUp, tripSpend, tripViewOf, type TripView } from "./tripview";

const EMAIL = "application/vnd.engram.email+json";
const NOW = Date.UTC(2026, 9, 26, 17); // Mon 26 Oct 2026, 10:00 in San Francisco
const TAG = "trip:lisbon-2026-11";

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
const file = (id: string, facts: Fact[], extra: Partial<RowFile> = {}): RowFile => ({
  id,
  name: `${id}.pdf`,
  mime: "application/pdf",
  mtime: Date.UTC(2026, 9, 1),
  tags: [],
  facts,
  trashed: false,
  ...extra,
});
const email = (id: string, day: string, facts: Fact[], extra: Partial<RowFile> = {}) =>
  file(id, facts, { name: `${id}.email`, mime: EMAIL, mail: { subject: id, from: "Sender", date: Date.parse(`${day}T12:00:00Z`) }, ...extra });

const flights = (extra: Partial<Fact> = {}) => [
  exact("event", "2026-11-12", "Flight TP 236 departs SFO", { time: "18:10" }),
  exact("event", "2026-11-13", "Flight TP 236 arrives LIS", { time: "14:05" }),
  exact("event", "2026-11-16", "Flight TP 237 departs LIS", { time: "13:20", ...extra }),
  exact("event", "2026-11-16", "Flight TP 237 arrives SFO", { time: "17:05", ...extra }),
  exact("identifier", "4F2K", "Confirmation number", { masked: "4F2K" }),
];
const hotel = () => [
  exact("event", "2026-11-13", "Check-in: Casa do Rio", { document: "hotel-booking", time: "15:00" }),
  exact("event", "2026-11-16", "Check-out: Casa do Rio", { document: "hotel-booking", time: "11:00" }),
  exact("identifier", "9C1D", "Confirmation number", { document: "hotel-booking", masked: "9C1D" }),
];
const lisbon = (returnFlight: Partial<Fact> = {}): RowFile[] => [
  email("booking", "2026-10-01", flights(returnFlight)),
  email("hotel", "2026-10-02", hotel()),
  file("museum", [
    exact("event", "2026-11-14", "Museu do Azulejo", { document: "event-ticket", time: "10:00" }),
    exact("amount", "18.00", undefined, { unit: "EUR", document: "event-ticket" }),
  ]),
  file("fado", [exact("event", "2026-11-14", "Fado night", { document: "event-ticket", time: "21:00" })]),
  file("dinner", [exact("event", "2026-11-15", "Table at Taberna da Rua", { document: "dining", time: "20:00" })]),
  email("receipt", "2026-11-15", [exact("amount", "96.00", undefined, { unit: "EUR", document: "invoice", source: "label", confidence: 0.7, confirmed: true })]),
];

/** The trip as assembly leaves it: its plan, and its tag on the members. */
async function trip(files: RowFile[], extra: RowFile[] = [], groupedByOwner = false): Promise<{ view: TripView; rows: AgendaRow[]; plan: TripPlan }> {
  const [plan] = await planTrips(files, NOW);
  const tagged = files.map((member) =>
    groupedByOwner || plan!.exact.has(member.id) || member.id === "receipt" ? { ...member, tags: [TAG] } : member,
  );
  const all = [...tagged, ...extra];
  const ctx: RowContext = { plans: [plan!], dismissed: new Set(), excluded: new Set(), assembling: true };
  const rows = await rowsOf(all, ctx, NOW);
  const view = await tripViewOf(tripsOf(all).find((candidate) => candidate.tag === TAG)!, rows, { plan: plan! });
  return { view, rows, plan: plan! };
}

describe("tripViewOf", () => {
  it("a trip reads as legs, a stay and bookings", async () => {
    const { view } = await trip(lisbon());
    expect(view).toMatchObject({
      tag: TAG,
      title: "Lisbon, Nov 2026",
      city: "Lisbon",
      code: "LIS",
      country: "PT",
      zone: "Europe/Lisbon",
      start: "2026-11-12",
      end: "2026-11-16",
      international: true,
      exact: true,
    });
    expect(view.legs.map((leg) => [leg.designator, leg.dep?.at, leg.arr?.at])).toEqual([
      ["TP 236", Date.UTC(2026, 10, 13, 2, 10), Date.UTC(2026, 10, 13, 14, 5)],
      ["TP 237", Date.UTC(2026, 10, 16, 13, 20), Date.UTC(2026, 10, 17, 1, 5)],
    ]);
    expect(view.stays).toHaveLength(1);
    expect(view.stays[0]).toMatchObject({ name: "Casa do Rio", nights: 3, fileId: "hotel" });
    expect(view.stays[0]!.checkIn).toMatchObject({ day: "2026-11-13", time: "15:00", at: Date.UTC(2026, 10, 13, 15, 0) });
    expect(view.stays[0]!.checkOut).toMatchObject({ day: "2026-11-16", time: "11:00" });
    expect(view.stays[0]!.refFactId).toBeDefined();
    expect(view.booked.map((row) => row.title)).toEqual(["Museu do Azulejo", "Fado night", "Table at Taberna da Rua"]);
    expect(view.sources).toEqual({ email: 3, pdf: 3, other: 0 });
  });

  it("a trip with no flights still has a destination and a stay", async () => {
    const files = [email("hotel", "2026-10-02", hotel(), { tags: [TAG] }), file("fado", [exact("event", "2026-11-14", "Fado night", { time: "21:00" })], { tags: [TAG] })];
    const rows = await rowsOf(files, { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true }, NOW);
    const view = await tripViewOf(tripsOf(files)[0]!, rows, {});
    expect(view).toMatchObject({ city: "Lisbon", zone: "Europe/Lisbon", start: "2026-11-13", end: "2026-11-16", international: false, exact: false });
    expect(view.legs).toEqual([]);
    expect(view.stays.map((stay) => [stay.name, stay.nights])).toEqual([["Casa do Rio", 3]]);
  });

  it("a file left out of the trip is not in its view", async () => {
    const { view } = await trip(lisbon(), [file("concert", [exact("event", "2026-11-14", "Another concert", { time: "22:00" })])]);
    expect(view.booked.map((row) => row.title)).not.toContain("Another concert");
    expect(view.memberIds).not.toContain("concert");
  });

  it("an asking date never sets a time", async () => {
    // The way home was read without certainty and nobody has said yes yet;
    // the owner grouped the trip's files.
    const { view } = await trip(lisbon({ source: "label", confidence: 0.7, accepted: undefined }), [], true);
    expect(view.legs.map((leg) => leg.designator)).toEqual(["TP 236"]);
    expect(view.end).toBe("2026-11-16");
  });
});

describe("tripSpend", () => {
  it("spend sums the trip's bills and tickets per currency and names a receipt waiting", async () => {
    const taxi = email("taxi", "2026-11-13", [exact("amount", "38.00", undefined, { unit: "EUR", document: "invoice", source: "label", confidence: 0.7, confirmed: true })]);
    const { view, rows } = await trip(lisbon(), [taxi]);
    const spend = tripSpend(view, rows);
    expect(spend.sums).toEqual([{ currency: "EUR", value: "114.00" }]);
    expect(spend.count).toBe(2);
    expect(spend.waiting?.fileIds).toEqual(["taxi"]);
  });
});

describe("comingUp", () => {
  it("coming up skips the trip and photo days", async () => {
    const dentist = file("dentist", [exact("event", "2026-11-20", "Dentist", { time: "09:30" })]);
    const photo = file("beach", [], { name: "beach.jpg", mime: "image/jpeg", mtime: Date.UTC(2026, 10, 1, 12) });
    const { view, rows } = await trip(lisbon(), [dentist, photo]);
    expect(comingUp(rows, view, NOW, 2).map((row) => row.title)).toEqual(["Dentist"]);
    expect(comingUp(rows, undefined, NOW, 2).map((row) => row.title)).toEqual(["San Francisco to Lisbon", "Check in · Casa do Rio"]);
  });
});
