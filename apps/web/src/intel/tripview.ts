/**
 * A trip read as what it is: its legs, its stays, what is booked, where it
 * goes, and what it costs.
 *
 * Built from the Timeline's rows and the legs they carry, never from labels:
 * by the time a trip is read here, every fact has already said what it is.
 * A date nobody has said yes to never sets a time, and a file left out of
 * the trip is not part of it.
 */
import type { Trip, TripPlan } from "./agenda";
import type { AgendaRow, RowFile } from "./agendarows";
import { airportForCity, lookupAirport, type Airport } from "./airports";
import { sum, type Money } from "./everyday";
import type { Fact } from "./facts";
import { deviceZone } from "./instants";
import type { Leg, Stop } from "./legs";
import { subjectOf } from "./subject";
import { departureAdvice, tripTitle } from "./trips";
import { isEmailRecord } from "../mail/kind";

export interface Stay {
  /** The place as booked; empty when the booking named none. */
  name: string;
  address?: string;
  checkIn?: Stop;
  checkOut?: Stop;
  nights: number;
  fileId: string;
  /** The booking reference stated with it, for Reveal. */
  refFactId?: string;
}

export interface TripView {
  tag: string;
  title: string;
  /** Where the trip goes. */
  city: string;
  code?: string;
  /** The destination's country, as its ISO code. */
  country?: string;
  zone: string;
  /** The first departure's and the last arrival's own printed days. */
  start: string;
  end: string;
  legs: Leg[];
  stays: Stay[];
  booked: AgendaRow[];
  international: boolean;
  memberIds: string[];
  sources: { email: number; pdf: number; other: number };
  /** An exact journey anchors the trip: it was found, not guessed. */
  exact: boolean;
  /** When to leave for each leg's airport, in the legs' order; null where it cannot be said. */
  leaveBy: (Advice | null)[];
  /** The city each airport code the legs name is in. */
  cities: Record<string, string>;
}

export type Advice = NonNullable<Awaited<ReturnType<typeof departureAdvice>>>;

const CODE = /^[A-Z]{3}$/;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const byTime = (a: AgendaRow, b: AgendaRow) => a.at - b.at || a.id.localeCompare(b.id);

async function destinationOf(trip: Trip<RowFile>, legs: readonly Leg[], plan: TripPlan | undefined): Promise<Airport | null> {
  // The plan's destination is the commonest arrival away from home, which a
  // connecting flight's first stop is not.
  const named = plan?.destination ? await airportForCity(plan.destination) : null;
  if (named) {
    return named;
  }
  const first = legs[0];
  const code = first?.arr?.code ?? (first && CODE.test(first.to) ? first.to : undefined);
  const landed = code ? await lookupAirport(code) : null;
  return landed ?? (await airportForCity(tripTitle(trip.tag).split(",")[0]!));
}

async function crossesBorder(leg: Leg): Promise<boolean> {
  const toCode = leg.arr?.code ?? (CODE.test(leg.to) ? leg.to : undefined);
  const from = leg.dep?.code ? await lookupAirport(leg.dep.code) : null;
  const to = toCode ? await lookupAirport(toCode) : null;
  return Boolean(from && to && from.country !== to.country);
}

/** The trip's stays: each check-in with the check-out of the same place. */
function staysOf(rows: readonly AgendaRow[], facts: ReadonlyMap<string, { fact: Fact; file: RowFile }>, zone: string): Stay[] {
  const stays: (Stay & { reservation?: number })[] = [];
  for (const row of rows) {
    const found = facts.get(row.factIds?.[0] ?? "");
    const subject = found && subjectOf(found.fact);
    if (!found || !subject) {
      continue;
    }
    const name = subject.place ?? "";
    const stop: Stop = { day: row.day, ...(row.time ? { time: row.time } : {}), zone, at: row.at, place: name, factId: found.fact.id };
    const reservation = subject.reservation;
    if (subject.role === "check-in") {
      stays.push({ name, ...(subject.address ? { address: subject.address } : {}), checkIn: stop, nights: 0, fileId: found.file.id, ...(reservation !== undefined ? { reservation } : {}) });
      continue;
    }
    const open = [...stays]
      .reverse()
      .find(
        (stay) =>
          !stay.checkOut &&
          stay.name.toLowerCase() === name.toLowerCase() &&
          (stay.reservation === undefined || reservation === undefined || stay.reservation === reservation),
      );
    if (open) {
      open.checkOut = stop;
      open.nights = open.checkIn ? dayNumber(stop.day) - dayNumber(open.checkIn.day) : 0;
    } else {
      stays.push({ name, ...(subject.address ? { address: subject.address } : {}), checkOut: stop, nights: 0, fileId: found.file.id, ...(reservation !== undefined ? { reservation } : {}) });
    }
  }
  return stays.map(({ reservation, ...stay }) => {
    const file = facts.get(stay.checkIn?.factId ?? stay.checkOut?.factId ?? "")?.file;
    const reference = file?.facts.find((fact) => {
      const said = subjectOf(fact);
      return fact.kind === "identifier" && said?.role === "reference" && (reservation === undefined || said.reservation === undefined || said.reservation === reservation);
    });
    return reference ? { ...stay, refFactId: reference.id } : stay;
  });
}

/** A tagged trip read from the Timeline's rows. */
export async function tripViewOf(
  trip: Trip<RowFile>,
  rows: readonly AgendaRow[],
  opts: { plan?: TripPlan; homeCountry?: string },
): Promise<TripView> {
  const members = new Set(trip.members.map((file) => file.id));
  const mine = rows.filter((row) => row.kind !== "trip" && !row.ask && row.fileIds.some((id) => members.has(id))).sort(byTime);
  const legs = mine
    .flatMap((row) => (row.kind === "flight" && row.flight ? [row.flight.leg] : []))
    .sort((a, b) => (a.dep ?? a.arr)!.at - (b.dep ?? b.arr)!.at);
  const facts = new Map(trip.members.flatMap((file) => file.facts.map((fact) => [fact.id, { fact, file }] as const)));

  const airport = await destinationOf(trip, legs, opts.plan);
  const zone = airport?.zone ?? deviceZone();
  const stays = staysOf(mine.filter((row) => row.kind === "stay"), facts, zone);
  const international =
    (await Promise.all(legs.map(crossesBorder))).some(Boolean) ||
    (opts.homeCountry !== undefined && airport !== null && airport.country !== opts.homeCountry);

  const firsts = [legs[0] && (legs[0].dep ?? legs[0].arr)!.day, stays[0] && (stays[0].checkIn ?? stays[0].checkOut)!.day, trip.start];
  const lastLeg = legs.at(-1);
  const lastStay = stays.at(-1);
  const lasts = [lastLeg && (lastLeg.arr ?? lastLeg.dep)!.day, lastStay && (lastStay.checkOut ?? lastStay.checkIn)!.day, trip.end];
  const days = (list: (string | undefined)[]) => list.filter((day): day is string => day !== undefined).sort();

  const sources = { email: 0, pdf: 0, other: 0 };
  for (const file of trip.members) {
    sources[isEmailRecord(file.name, file.mime) ? "email" : file.mime === "application/pdf" ? "pdf" : "other"]++;
  }
  const city = airport?.city ?? opts.plan?.destination ?? tripTitle(trip.tag).split(",")[0]!;
  const cities: Record<string, string> = {};
  for (const code of new Set(legs.flatMap((leg) => [leg.dep?.code, leg.arr?.code, CODE.test(leg.to) ? leg.to : undefined]))) {
    const place = code ? await lookupAirport(code) : null;
    if (place) {
      cities[code!] = place.city;
    }
  }
  return {
    tag: trip.tag,
    title: opts.plan?.title ?? tripTitle(trip.tag),
    city,
    ...(airport ? { code: airport.code, country: airport.country } : {}),
    zone,
    start: days(firsts)[0] ?? "",
    end: days(lasts).at(-1) ?? "",
    legs,
    stays,
    booked: mine.filter((row) => row.kind === "event"),
    international,
    memberIds: [...members],
    sources,
    exact: opts.plan?.anchorId !== undefined,
    leaveBy: await Promise.all(legs.map(departureAdvice)),
    cities,
  };
}

/** What the trip cost so far: exact amounts per currency, and one receipt that only shares its dates. */
export function tripSpend(view: TripView, rows: readonly AgendaRow[]): { sums: Money[]; count: number; waiting?: AgendaRow } {
  const members = new Set(view.memberIds);
  const spent = rows.filter(
    (row) => !row.ask && row.amount && (row.kind === "bill" || row.kind === "event") && row.fileIds.some((id) => members.has(id)),
  );
  const waiting = rows.find(
    (row) => row.kind === "bill" && row.trip?.tag === view.tag && row.trip.evidence === "weak" && row.day >= view.start && row.day <= view.end,
  );
  return { sums: sum(spent), count: spent.length, ...(waiting ? { waiting } : {}) };
}

/** The next rows after now that are not this trip's, photos or questions. */
export function comingUp(rows: readonly AgendaRow[], view: TripView | undefined, now: number, count: number): AgendaRow[] {
  const members = new Set(view?.memberIds ?? []);
  return rows
    .filter((row) => row.at > now && row.kind !== "photos" && row.kind !== "trip" && !row.fileIds.some((id) => members.has(id)))
    .sort(byTime)
    .slice(0, count);
}
