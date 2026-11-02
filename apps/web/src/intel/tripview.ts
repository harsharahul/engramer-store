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
import { lookupAirport, placeForCity, plainCity, type Airport } from "./airports";
import { sum, type Money } from "./everyday";
import type { Fact } from "./facts";
import type { TripWindow } from "./insights";
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

/**
 * Where the trip goes: the airport the legs stay at longest before leaving
 * again, never a hub where they only change planes. With no legs to say,
 * the trip's city name, and only as far as that name is unambiguous.
 */
async function destinationOf(
  trip: Trip<RowFile>,
  legs: readonly Leg[],
  plan: TripPlan | undefined,
): Promise<{ city: string; code?: string; country?: string; zone?: string } | null> {
  const origin = legs.find((leg) => leg.dep)?.dep?.code;
  let landed: Leg | undefined;
  let longest = -1;
  for (const leg of legs) {
    const code = leg.arr?.code ?? (CODE.test(leg.to) ? leg.to : undefined);
    if (!code || code === origin) {
      continue;
    }
    const arrivedAt = leg.arr?.at ?? leg.dep?.at ?? 0;
    const next = legs.find((other) => other.dep && other.dep.at > arrivedAt);
    const stay = next ? next.dep!.at - arrivedAt : Number.POSITIVE_INFINITY;
    if (stay > longest) {
      longest = stay;
      landed = leg;
    }
  }
  const code = landed ? (landed.arr?.code ?? landed.to) : undefined;
  const airport: Airport | null = code ? await lookupAirport(code) : null;
  if (airport) {
    return { ...airport, city: plainCity(airport.city) };
  }
  const city = plan?.destination ?? tripTitle(trip.tag).split(",")[0]!;
  const place = await placeForCity(city);
  return { city, ...(place ?? {}) };
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
    // A check-out closes the stay its own booking opened, first; else one of
    // the same name, where a missing name matches any.
    const fits = (stay: Stay & { reservation?: number }) =>
      !stay.checkOut && (stay.reservation === undefined || reservation === undefined || stay.reservation === reservation);
    const sameName = (stay: Stay) => !stay.name || !name || stay.name.toLowerCase() === name.toLowerCase();
    const open =
      [...stays].reverse().find((stay) => fits(stay) && stay.fileId === found.file.id) ??
      [...stays].reverse().find((stay) => fits(stay) && sameName(stay));
    if (open) {
      open.checkOut = stop;
      open.nights = open.checkIn ? dayNumber(stop.day) - dayNumber(open.checkIn.day) : 0;
      if (!open.name && name) {
        open.name = name;
      }
    } else {
      stays.push({ name, ...(subject.address ? { address: subject.address } : {}), checkOut: stop, nights: 0, fileId: found.file.id, ...(reservation !== undefined ? { reservation } : {}) });
    }
  }
  // A reminder email books nothing new: one stay per place and dates.
  const seen = new Set<string>();
  const once = stays.filter((stay) => {
    const key = `${stay.name.toLowerCase()}|${stay.checkIn?.day ?? ""}|${stay.checkOut?.day ?? ""}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return once.map(({ reservation, ...stay }) => {
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
  // A booking change repeats the same flights: one leg per service and moment.
  const flown = new Set<string>();
  const legs = mine
    .flatMap((row) => (row.kind === "flight" && row.flight ? [row.flight.leg] : []))
    .sort((a, b) => (a.dep ?? a.arr)!.at - (b.dep ?? b.arr)!.at)
    .filter((leg) => {
      const key = `${leg.key}|${(leg.dep ?? leg.arr)!.at}`;
      return flown.has(key) ? false : (flown.add(key), true);
    });
  const facts = new Map(trip.members.flatMap((file) => file.facts.map((fact) => [fact.id, { fact, file }] as const)));

  const airport = await destinationOf(trip, legs, opts.plan);
  // A stay's own printed zone speaks for the place when its name could not.
  const printed = [...facts.values()].find(({ fact }) => fact.zone && subjectOf(fact)?.role === "check-in")?.fact.zone;
  const zone = airport?.zone ?? printed ?? deviceZone();
  const stays = staysOf(mine.filter((row) => row.kind === "stay"), facts, zone);
  const international =
    (await Promise.all(legs.map(crossesBorder))).some(Boolean) ||
    (opts.homeCountry !== undefined && airport?.country !== undefined && airport.country !== opts.homeCountry);

  // The trip's own days come from its journeys and stays; any other dated
  // member (a dinner at home the owner added) does not stretch them.
  const own = [
    ...legs.flatMap((leg) => [leg.dep?.day, leg.arr?.day]),
    ...stays.flatMap((stay) => [stay.checkIn?.day, stay.checkOut?.day]),
  ]
    .filter((day): day is string => day !== undefined)
    .sort();
  const firsts = own.length > 0 ? own : [trip.start];
  const lasts = own.length > 0 ? own : [trip.end];
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
    ...(airport?.code ? { code: airport.code } : {}),
    ...(airport?.country ? { country: airport.country } : {}),
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

/** The trip as the checks read it, the same for the bell and the hero. */
export function windowOf(view: TripView): TripWindow {
  const landing = view.legs.find((leg) => leg.arr && leg.arr.code !== undefined && leg.arr.code === view.code) ?? view.legs.find((leg) => leg.arr);
  return {
    tag: view.tag,
    start: view.start,
    end: view.end,
    international: view.international,
    memberIds: view.memberIds,
    ...(landing?.arr ? { firstArrival: { day: landing.arr.day, ...(landing.arr.time ? { time: landing.arr.time } : {}) } } : {}),
    stays: view.stays.map((stay) => ({
      name: stay.name,
      ...(stay.checkIn ? { checkIn: { day: stay.checkIn.day, ...(stay.checkIn.time ? { time: stay.checkIn.time } : {}) } } : {}),
      ...(stay.checkOut ? { checkOut: { day: stay.checkOut.day } } : {}),
      fileId: stay.fileId,
    })),
    // Every night between leaving and landing, two across the date line.
    overnightLegs: view.legs.flatMap((leg) => {
      const nights: string[] = [];
      for (let day = leg.dep?.day; leg.arr && day && day < leg.arr.day; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        nights.push(day);
      }
      return nights;
    }),
  };
}

/** What the trip cost so far: exact amounts per currency, and one receipt that only shares its dates. */
export function tripSpend(view: TripView, rows: readonly AgendaRow[]): { sums: Money[]; count: number; waiting?: AgendaRow } {
  const members = new Set(view.memberIds);
  // A ticket's price shows on each of its days; it was paid once.
  const paid = new Set<string>();
  const spent = rows.filter((row) => {
    if (row.ask || !row.amount || (row.kind !== "bill" && row.kind !== "event") || !row.fileIds.some((id) => members.has(id))) {
      return false;
    }
    return paid.has(row.fileIds[0]!) ? false : (paid.add(row.fileIds[0]!), true);
  });
  const waiting = rows.find(
    (row) => row.kind === "bill" && row.trip?.tag === view.tag && row.trip.evidence === "weak" && row.day >= view.start && row.day <= view.end,
  );
  return { sums: sum(spent), count: spent.length, ...(waiting ? { waiting } : {}) };
}

/** The next rows after now that are not this trip's, photos or questions. */
export function comingUp(rows: readonly AgendaRow[], view: TripView | undefined, now: number, count: number): AgendaRow[] {
  const members = new Set(view?.memberIds ?? []);
  return rows
    .filter((row) => row.at > now && !row.ask && row.kind !== "photos" && row.kind !== "trip" && !row.fileIds.some((id) => members.has(id)))
    .sort(byTime)
    .slice(0, count);
}
