/**
 * Where a trip stands right now, and the words its poster says.
 *
 * Seven moments follow one trip: Planning (from a month before), Soon (the
 * last week), Travel day, In the air, Staying, Last day, and Back home (three
 * days after landing). Everything is read from the trip view and the clock,
 * in real instants: a leg is in the air between its two instants, and a day
 * count is the destination's own calendar day, whatever the device's zone.
 */
import { dayLabel, durationLabel } from "./everyday";
import { instantOf, zonedDay, zonedTime } from "./instants";
import type { Leg, Stop } from "./legs";
import { skyOf, type Sky } from "./sun";
import type { Advice, Stay, TripView } from "./tripview";
import type { LatLon } from "./airports";

export type MomentKind = "everyday" | "planning" | "soon" | "travel" | "air" | "staying" | "last" | "home";

export interface Moment {
  kind: MomentKind;
  trip?: TripView;
  /** Calendar days to the first departure, at its own airport. */
  daysUntil?: number;
  /** The next departure. */
  next?: Leg;
  flying?: { leg: Leg; progress: number };
  day?: { n: number; of: number };
  night?: { n: number; of: number; stay: Stay };
  /** Nights in the destination, for a trip with no stay booked. */
  nights?: number;
  leaveBy?: Advice & { code: string };
  /** The next departure less a day: when check-in usually opens. */
  checkInOpens?: number;
}

export const PLANNING_DAYS = 30;
export const BACK_HOME_DAYS = 3;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;

/** The trip's spine: when it starts and ends, the way out, the arrival, the way home. */
interface Shape {
  view: TripView;
  startAt: number;
  endAt: number;
  outbound?: Leg;
  arrival?: Leg;
  homeward?: Leg;
  firstStay?: Stay;
  lastStay?: Stay;
}

/**
 * A trip's journey: the first leg out, the leg that lands at the
 * destination, and the first leg that leaves it again. The poster, the
 * moments and the cards all read the journey from here.
 */
export function journeyOf(view: TripView): { outbound?: Leg; arrival?: Leg; homeward?: Leg } {
  const legs = view.legs;
  const outbound = legs.find((leg) => leg.dep);
  const arrival = legs.find((leg) => leg.arr && leg.arr.code !== undefined && leg.arr.code === view.code) ?? legs.find((leg) => leg.arr);
  // The way home starts with the first leg that leaves the destination.
  const homeward = arrival?.arr ? legs.find((leg) => leg !== arrival && leg.dep && leg.dep.at >= arrival.arr!.at) : undefined;
  return { ...(outbound ? { outbound } : {}), ...(arrival ? { arrival } : {}), ...(homeward ? { homeward } : {}) };
}

function shapeOf(view: TripView): Shape {
  const legs = view.legs;
  const { outbound, arrival, homeward } = journeyOf(view);
  const firstStay = view.stays[0];
  const lastStay = view.stays.at(-1);
  const last = legs.at(-1);
  const startAt = outbound?.dep?.at ?? firstStay?.checkIn?.at ?? instantOf(view.start, undefined, view.zone);
  const ends = (stop: Stop | undefined) => (stop ? (stop.time ? stop.at : endOfDay(stop)) : undefined);
  const endAt = homeward
    ? (ends(last!.arr) ?? leaves(last!.dep!))
    : (ends(lastStay?.checkOut) ?? (last ? (ends(last.arr) ?? leaves(last.dep!)) : instantOf(view.end, "23:59", view.zone)));
  return {
    view,
    startAt,
    endAt,
    ...(outbound ? { outbound } : {}),
    ...(arrival ? { arrival } : {}),
    ...(homeward ? { homeward } : {}),
    ...(firstStay ? { firstStay } : {}),
    ...(lastStay ? { lastStay } : {}),
  };
}

function endOfDay(stop: Stop): number {
  return instantOf(stop.day, "23:59", stop.zone);
}

/** When a departure is gone: its time, or, with none printed, the end of its day. */
function leaves(stop: Stop): number {
  return stop.time ? stop.at : endOfDay(stop);
}

/** Calendar days from today to the first departure, both read at the place it leaves from. */
function daysUntil(shape: Shape, now: number): number {
  const zone = shape.outbound?.dep?.zone ?? shape.view.zone;
  const day = shape.outbound?.dep?.day ?? shape.firstStay?.checkIn?.day ?? shape.view.start;
  return dayNumber(day) - dayNumber(zonedDay(now, zone));
}

/** The trip under way, else the nearest within a month, else one just over. */
function chosen(views: readonly TripView[], now: number): Shape | undefined {
  const shapes = views.map(shapeOf);
  const byStart = (a: Shape, b: Shape) => a.startAt - b.startAt;
  return (
    shapes.filter((shape) => shape.startAt <= now && now < shape.endAt).sort(byStart)[0] ??
    shapes.filter((shape) => shape.startAt > now && daysUntil(shape, now) <= PLANNING_DAYS).sort(byStart)[0] ??
    shapes.filter((shape) => shape.endAt <= now && now < shape.endAt + BACK_HOME_DAYS * DAY).sort((a, b) => b.endAt - a.endAt)[0]
  );
}

/** Where one trip stands at `now`, or the ordinary day when no trip is near. */
export function momentOf(views: readonly TripView[], now: number): Moment {
  const shape = chosen(views, now);
  if (!shape) {
    return { kind: "everyday" };
  }
  const { view, outbound, homeward } = shape;
  const destDay = zonedDay(now, view.zone);
  const leave = (leg: Leg | undefined) => {
    const advice = leg ? view.leaveBy[view.legs.indexOf(leg)] : null;
    return advice && leg?.dep?.code ? { leaveBy: { ...advice, code: leg.dep.code } } : {};
  };
  // A departure with no printed time has no check-in hour and no countdown;
  // only a flight has an online check-in to open.
  const departing = (leg: Leg | undefined, leaving = true) =>
    leg?.dep
      ? {
          next: leg,
          ...(leg.dep.time && leg.mode === "flight" ? { checkInOpens: leg.dep.at - 24 * HOUR } : {}),
          ...(leaving ? leave(leg) : {}),
        }
      : {};
  const dayCount = () => {
    const of = dayNumber(view.end) - dayNumber(view.start) + 1;
    const n = Math.min(Math.max(dayNumber(destDay) - dayNumber(view.start) + 1, 1), of);
    return view.start && view.end ? { day: { n, of } } : {};
  };
  const tonight = () => {
    const stay = view.stays.find((candidate) => candidate.checkIn && candidate.checkOut && candidate.checkIn.day <= destDay && destDay < candidate.checkOut.day);
    if (stay) {
      return { night: { n: dayNumber(destDay) - dayNumber(stay.checkIn!.day) + 1, of: stay.nights, stay } };
    }
    if (view.stays.length === 0 && shape.arrival?.arr && homeward?.dep) {
      return { nights: dayNumber(homeward.dep.day) - dayNumber(shape.arrival.arr.day) };
    }
    return {};
  };
  const base = { trip: view };

  // Only a leg with both times printed is known to be in the air.
  const flying = view.legs.find((leg) => leg.dep?.time && leg.arr?.time && leg.dep.at <= now && now < leg.arr.at);
  if (flying) {
    return { kind: "air", ...base, flying: { leg: flying, progress: (now - flying.dep!.at) / (flying.arr!.at - flying.dep!.at) } };
  }

  if (outbound?.dep && now < leaves(outbound.dep) && zonedDay(now, outbound.dep.zone) === outbound.dep.day) {
    return { kind: "travel", ...base, ...departing(outbound) };
  }
  const arrivalAt = shape.arrival?.arr?.at;
  if (outbound?.dep && arrivalAt !== undefined && now >= leaves(outbound.dep) && now < arrivalAt) {
    // Between connections on the way out: already airside, so no leave-by.
    return { kind: "travel", ...base, ...departing(view.legs.find((leg) => leg.dep && leg.dep.at > now), false) };
  }
  if (!outbound && shape.firstStay?.checkIn && now < shape.firstStay.checkIn.at && destDay === shape.firstStay.checkIn.day) {
    return { kind: "travel", ...base };
  }

  if (now >= shape.startAt && now < shape.endAt) {
    const checkOut = shape.lastStay?.checkOut;
    // With a flight home, the last day is that flight's day; without one, the check-out's.
    const lastDay = homeward?.dep
      ? destDay === homeward.dep.day && now < leaves(homeward.dep)
      : checkOut !== undefined && destDay === checkOut.day;
    if (lastDay) {
      return { kind: "last", ...base, ...dayCount(), ...departing(homeward) };
    }
    if (!homeward?.dep || now < leaves(homeward.dep)) {
      return { kind: "staying", ...base, ...dayCount(), ...tonight(), ...departing(homeward) };
    }
    // On the way home, between connections.
    return { kind: "last", ...base, ...dayCount() };
  }

  if (now >= shape.endAt) {
    // A trip flown out to with no known way back has not come home.
    return outbound && !homeward ? { kind: "everyday" } : { kind: "home", ...base };
  }
  const days = daysUntil(shape, now);
  if (days >= 1 && days <= 7) {
    return { kind: "soon", ...base, daysUntil: days, ...departing(outbound) };
  }
  if (days >= 8 && days <= PLANNING_DAYS) {
    return { kind: "planning", ...base, daysUntil: days, ...(outbound ? { next: outbound } : {}) };
  }
  return { kind: "everyday" };
}

export interface Poster {
  top: string;
  city: string;
  code: string;
  big: string;
  cap: string;
  /** A ticking countdown inside the caption, when it has one. */
  until?: { lead: string; at: number };
  /** The meta line: `lead`, then a live clock in `clockZone`, then `tail`. */
  lead: string;
  clockZone?: string;
  tail?: string;
  meta: string;
  /** The sky over the poster's city at this moment, by its sun when known. */
  sky: Sky;
}

const SHORT_COUNTRIES: Record<string, string> = { US: "USA", GB: "UK", AE: "UAE" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A country's short name from its ISO code: "Portugal", "USA". */
export function countryName(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  if (SHORT_COUNTRIES[code]) {
    return SHORT_COUNTRIES[code];
  }
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    return undefined;
  }
}

/** "12-16 Nov 2026", "28 Nov-2 Dec 2026", "30 Dec 2026-2 Jan 2027"; "12-16 Nov" without the year. */
export function rangeLabel(start: string, end: string, withYear = true): string {
  const [y1, m1, d1] = start.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = end.split("-").map(Number) as [number, number, number];
  if (y1 !== y2) {
    return `${d1} ${MONTHS[m1 - 1]} ${y1}-${d2} ${MONTHS[m2 - 1]} ${y2}`;
  }
  const year = withYear ? ` ${y1}` : "";
  return m1 === m2 ? `${d1}-${d2} ${MONTHS[m1 - 1]}${year}` : `${d1} ${MONTHS[m1 - 1]}-${d2} ${MONTHS[m2 - 1]}${year}`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const named = (leg: Leg) => leg.designator || `Your ${leg.mode}`;

/** The poster's words for a trip moment; null for the ordinary day. */
export function posterOf(
  moment: Moment,
  now: number,
  homeZone: string,
  opts: { photos?: number; homePlace?: LatLon } = {},
): Poster | null {
  const view = moment.trip;
  if (moment.kind === "everyday" || !view) {
    return null;
  }
  const home = moment.kind === "home";
  const country = countryName(view.country);
  // Back home, the sky is home's; otherwise the destination's.
  const sky = home ? skyOf(now, homeZone, opts.homePlace) : skyOf(now, view.zone, view.place);
  const place = { city: view.city, code: view.code ?? "" };
  const lead = home
    ? [country, rangeLabel(view.start, view.end), opts.photos ? count(opts.photos, "photo") : undefined].filter(Boolean).join(" · ")
    : [country, dayLabel(zonedDay(now, view.zone))].filter(Boolean).join(" · ");
  const meta = home
    ? { lead, meta: lead }
    : { lead, clockZone: view.zone, tail: `in ${view.city}`, meta: `${lead} · ${zonedTime(now, view.zone)} in ${view.city}` };
  const next = moment.next;
  // A caption always says something true: the city, when nothing more is known.
  const words = (top: string, big: string, cap: string, until?: Poster["until"]): Poster => ({
    top,
    ...place,
    big,
    cap: cap || `in ${view.city}`,
    ...(until ? { until } : {}),
    ...meta,
    sky,
  });
  const homeBy = (leg: Leg) => (leg.mode === "flight" ? "flight" : leg.mode);

  switch (moment.kind) {
    case "planning":
      return words("Next trip", count(moment.daysUntil!, "day"), next?.mode === "flight" ? "until you fly" : "until you leave");
    case "soon": {
      const big = moment.daysUntil === 1 ? "Tomorrow" : count(moment.daysUntil!, "day");
      if (!next?.dep) {
        return words("Next trip", big, "until you leave");
      }
      if (!next.dep.time) {
        return words("Next trip", big, `${named(next)} on ${dayLabel(next.dep.day)}`);
      }
      return words("Next trip", big, `${named(next)} in ${durationLabel(next.dep.at - now)}`, { lead: `${named(next)} in`, at: next.dep.at });
    }
    case "travel": {
      const checkIn = view.stays[0]?.checkIn;
      const cap = next?.dep
        ? next.dep.time
          ? `${named(next)} departs ${next.dep.time}`
          : `${named(next)} leaves today`
        : checkIn?.time
          ? `check-in from ${checkIn.time}`
          : "";
      return words("Travel day", "Today", cap);
    }
    case "air": {
      const leg = moment.flying!.leg;
      const lands = leg.arr!.code ? (view.cities[leg.arr!.code] ?? leg.to) : leg.to;
      return words(`${named(leg)} · ${leg.from} to ${leg.to}`, "In the air", leg.arr!.time ? `lands ${leg.arr!.time} ${lands} time` : `lands in ${lands}`);
    }
    case "staying": {
      const big = moment.day ? `Day ${moment.day.n} of ${moment.day.of}` : view.city;
      const night = moment.night;
      const cap = night
        ? `Night ${night.n} of ${night.of}${night.stay.name ? ` at ${night.stay.name}` : ""}`
        : moment.nights !== undefined
          ? `${count(moment.nights, "night")} in ${view.city}`
          : "";
      return words("You are here", big, cap);
    }
    case "last": {
      const checkOut = view.stays.at(-1)?.checkOut;
      const cap = next?.dep
        ? next.dep.time
          ? `${homeBy(next)} home at ${next.dep.time}`
          : `${homeBy(next)} home today`
        : checkOut?.time
          ? `check-out at ${checkOut.time}`
          : "";
      return words("You are here", "Last day", cap);
    }
    case "home":
      return words("Your last trip", "Welcome back", `${count(dayNumber(view.end) - dayNumber(view.start) + 1, "day")} in ${view.city}`);
  }
}
