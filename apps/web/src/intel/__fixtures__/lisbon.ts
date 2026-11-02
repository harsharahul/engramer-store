/**
 * The synthetic Lisbon trip the Timeline is checked against: TP 236 out of
 * San Francisco on 12 Nov, three nights at Casa do Rio, a museum, a fado
 * night, a dinner, a receipt, and TP 237 home on 16 Nov. Built through the
 * real readers' fact shapes, planning, rows and trip view, so tests above
 * the trip view start from what the app would hold.
 */
import { planTrips, tripsOf, type TripPlan } from "../agenda";
import { rowsOf, type AgendaRow, type RowContext, type RowFile } from "../agendarows";
import { withExactAcceptance, type Fact } from "../facts";
import { tripViewOf, type TripView } from "../tripview";

export const EMAIL = "application/vnd.engram.email+json";
/** Mon 26 Oct 2026, 10:00 in San Francisco. */
export const PLANNING_NOW = Date.UTC(2026, 9, 26, 17);
export const TAG = "trip:lisbon-2026-11";

let seq = 0;
export const exact = (kind: Fact["kind"], value: string, label: string | undefined, extra: Partial<Fact> = {}): Fact =>
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

export const file = (id: string, facts: Fact[], extra: Partial<RowFile> = {}): RowFile => ({
  id,
  name: `${id}.pdf`,
  mime: "application/pdf",
  mtime: Date.UTC(2026, 9, 1),
  tags: [],
  facts,
  trashed: false,
  ...extra,
});

export const email = (id: string, day: string, facts: Fact[], extra: Partial<RowFile> = {}) =>
  file(id, facts, { name: `${id}.email`, mime: EMAIL, mail: { subject: id, from: "Sender", date: Date.parse(`${day}T12:00:00Z`) }, ...extra });

export const flights = (returnFlight: Partial<Fact> = {}) => [
  exact("event", "2026-11-12", "Flight TP 236 departs SFO", { time: "18:10" }),
  exact("event", "2026-11-13", "Flight TP 236 arrives LIS", { time: "14:05" }),
  exact("event", "2026-11-16", "Flight TP 237 departs LIS", { time: "13:20", ...returnFlight }),
  exact("event", "2026-11-16", "Flight TP 237 arrives SFO", { time: "17:05", ...returnFlight }),
  exact("identifier", "4F2K", "Confirmation number", { masked: "4F2K" }),
];

export const hotel = () => [
  exact("event", "2026-11-13", "Check-in: Casa do Rio", { document: "hotel-booking", time: "15:00" }),
  exact("event", "2026-11-16", "Check-out: Casa do Rio", { document: "hotel-booking", time: "11:00" }),
  exact("identifier", "9C1D", "Confirmation number", { document: "hotel-booking", masked: "9C1D" }),
];

export const lisbonFiles = (returnFlight: Partial<Fact> = {}): RowFile[] => [
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

/** The trip as assembly leaves it: planned, tagged, and read into rows and a view. */
export async function lisbonTrip(
  files: RowFile[] = lisbonFiles(),
  extra: RowFile[] = [],
  groupedByOwner = false,
): Promise<{ view: TripView; rows: AgendaRow[]; plan: TripPlan; files: RowFile[] }> {
  const [plan] = await planTrips(files, PLANNING_NOW);
  const tagged = files.map((member) =>
    groupedByOwner || plan!.exact.has(member.id) || member.id === "receipt" ? { ...member, tags: [TAG] } : member,
  );
  const all = [...tagged, ...extra];
  const ctx: RowContext = { plans: [plan!], dismissed: new Set(), excluded: new Set(), assembling: true };
  const rows = await rowsOf(all, ctx, PLANNING_NOW);
  const view = await tripViewOf(tripsOf(all).find((candidate) => candidate.tag === TAG)!, rows, { plan: plan! });
  return { view, rows, plan: plan!, files: all };
}
