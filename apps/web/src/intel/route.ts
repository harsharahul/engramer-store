/**
 * A trip's route, drawn on the device: great circles between the airports
 * its legs name, from the coordinates in the airport table. No map service
 * learns where you are going; there is nothing to fetch.
 */

import type { LatLon } from "./airports";
import type { Leg } from "./legs";
import { journeyOf } from "./moments";
import type { TripView } from "./tripview";

const EARTH_KM = 6371;
const RAD = Math.PI / 180;
const CODE = /^[A-Z]{3}$/;

export interface RouteLine {
  from: string;
  to: string;
  /** Longitudes unwrapped, so a line over the date line stays in one piece. */
  points: LatLon[];
  /** How far along the flight in the air is, 0 to 1, drawn from `from`. */
  inAir?: number;
}

export interface RouteEnd {
  code: string;
  city: string;
  /** In the lines' frame: its longitude may lie past ±180. */
  at: LatLon;
}

export interface Route {
  /** One line per pair of airports, however many legs fly it. */
  lines: RouteLine[];
  origin: RouteEnd;
  destination: RouteEnd;
  /** Where the legs connect, between the origin and the destination. */
  stops: LatLon[];
  /** The journey out, rounded to 10 km. */
  km: number;
  /** The journey out, from the first departure to the landing; printed times only. */
  outMinutes?: number;
  bounds: { lon0: number; lon1: number; lat0: number; lat1: number };
}

/** The central angle between two points, in radians. */
function angle(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceKm(a: LatLon, b: LatLon): number {
  return angle(a, b) * EARTH_KM;
}

/** The shortest path over the globe from a to b, as steps + 1 points. */
export function greatCircle(a: LatLon, b: LatLon, steps = 100): LatLon[] {
  const d = angle(a, b);
  if (d === 0) {
    return Array.from({ length: steps + 1 }, () => ({ ...a }));
  }
  const [p1, l1, p2, l2] = [a.lat * RAD, a.lon * RAD, b.lat * RAD, b.lon * RAD];
  const points: LatLon[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const s = Math.sin((1 - f) * d) / Math.sin(d);
    const t = Math.sin(f * d) / Math.sin(d);
    const x = s * Math.cos(p1) * Math.cos(l1) + t * Math.cos(p2) * Math.cos(l2);
    const y = s * Math.cos(p1) * Math.sin(l1) + t * Math.cos(p2) * Math.sin(l2);
    const z = s * Math.sin(p1) + t * Math.sin(p2);
    points.push({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD });
  }
  return points;
}

const fromCode = (leg: Leg) => leg.dep?.code ?? (CODE.test(leg.from) ? leg.from : undefined);
const toCode = (leg: Leg) => leg.arr?.code ?? (CODE.test(leg.to) ? leg.to : undefined);

/** Longitudes made continuous along a line, then moved near `near`. */
function unwrap(points: LatLon[], near: number): LatLon[] {
  const out = points.map((p) => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    while (out[i]!.lon - out[i - 1]!.lon > 180) out[i]!.lon -= 360;
    while (out[i]!.lon - out[i - 1]!.lon < -180) out[i]!.lon += 360;
  }
  const shift = Math.round((near - out[0]!.lon) / 360) * 360;
  return out.map((p) => ({ lat: p.lat, lon: p.lon + shift }));
}

/** The flight in the air at `now`, as a fraction; only a leg with both times printed. */
function inAir(leg: Leg, now: number): number | undefined {
  if (leg.ask || !leg.dep?.time || !leg.arr?.time || leg.arr.at <= leg.dep.at) {
    return undefined;
  }
  return now >= leg.dep.at && now < leg.arr.at ? (now - leg.dep.at) / (leg.arr.at - leg.dep.at) : undefined;
}

/**
 * The route a trip's legs draw, or null when no leg has both ends in the
 * airport table (a train between stations, a hotel-only trip).
 */
export function routeOf(view: TripView, now: number): Route | null {
  const located = view.legs.filter((leg) => {
    const a = fromCode(leg);
    const b = toCode(leg);
    return a && b && a !== b && view.coords[a] && view.coords[b];
  });
  if (located.length === 0) {
    return null;
  }
  const { outbound, arrival } = journeyOf(view);
  const originCode = (outbound && located.includes(outbound) ? fromCode(outbound) : undefined) ?? fromCode(located[0]!)!;
  const destinationCode =
    view.code && view.coords[view.code] ? view.code : (arrival && located.includes(arrival) ? toCode(arrival) : undefined) ?? toCode(located[0]!)!;
  const originLon = view.coords[originCode]!.lon;

  const lines: RouteLine[] = [];
  const byPair = new Map<string, RouteLine>();
  for (const leg of located) {
    const a = fromCode(leg)!;
    const b = toCode(leg)!;
    const pair = [a, b].sort().join("-");
    let line = byPair.get(pair);
    if (!line) {
      line = { from: a, to: b, points: unwrap(greatCircle(view.coords[a]!, view.coords[b]!), originLon) };
      byPair.set(pair, line);
      lines.push(line);
    }
    const flying = inAir(leg, now);
    if (flying !== undefined) {
      // Progress is drawn from where this flight left: a flight home runs the line backwards.
      if (line.from !== a) {
        line.points = [...line.points].reverse();
        [line.from, line.to] = [line.to, line.from];
      }
      line.inAir = flying;
    }
  }

  // Each airport's place in the lines' frame, so ends and stops sit on them.
  const framed = new Map<string, LatLon>();
  for (const line of lines) {
    framed.set(line.from, line.points[0]!);
    framed.set(line.to, line.points.at(-1)!);
  }
  const end = (code: string): RouteEnd => ({ code, city: view.cities[code] ?? code, at: framed.get(code) ?? view.coords[code]! });
  const stops = [...framed.entries()].filter(([code]) => code !== originCode && code !== destinationCode).map(([, at]) => at);

  const out =
    outbound && arrival ? view.legs.slice(view.legs.indexOf(outbound), view.legs.indexOf(arrival) + 1) : [located[0]!];
  const outKm = out
    .filter((leg) => located.includes(leg))
    .reduce((sum, leg) => sum + distanceKm(view.coords[fromCode(leg)!]!, view.coords[toCode(leg)!]!), 0);
  const printed = outbound?.dep?.time && arrival?.arr?.time && !outbound.ask && !arrival.ask;
  const outMinutes = printed ? Math.round((arrival!.arr!.at - outbound!.dep!.at) / 60_000) : undefined;

  const all = lines.flatMap((line) => line.points);
  const lons = all.map((p) => p.lon);
  const lats = all.map((p) => p.lat);
  const [lon0, lon1, lat0, lat1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  // Room for each end's code and city, written beside and under its dot,
  // much as the design leaves about 15° around its San Francisco to Lisbon arc.
  const padLon = Math.max(10, (lon1 - lon0) * 0.15);
  const padLat = Math.max(10, (lat1 - lat0) * 0.5);

  return {
    lines,
    origin: end(originCode),
    destination: end(destinationCode),
    stops,
    km: Math.round(outKm / 10) * 10,
    ...(outMinutes !== undefined && outMinutes > 0 ? { outMinutes } : {}),
    bounds: {
      lon0: lon0 - padLon,
      lon1: lon1 + padLon,
      lat0: Math.max(-85, lat0 - padLat),
      lat1: Math.min(85, lat1 + padLat),
    },
  };
}
