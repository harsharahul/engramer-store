import { beforeAll, describe, expect, it } from "vitest";
import { lisbonTrip } from "./__fixtures__/lisbon";
import { lookupAirport, type LatLon } from "./airports";
import { instantOf } from "./instants";
import type { Leg, Stop } from "./legs";
import { distanceKm, greatCircle, routeOf } from "./route";
import type { TripView } from "./tripview";

const SFO = { lat: 37.62, lon: -122.38 };
const LIS = { lat: 38.77, lon: -9.13 };
const NOW = Date.UTC(2026, 9, 26, 17);

let lisbonView: TripView;
beforeAll(async () => {
  lisbonView = (await lisbonTrip()).view;
});

const stop = (code: string | undefined, place: string, day: string, time: string | undefined, zone = "UTC"): Stop => ({
  day,
  ...(time ? { time } : {}),
  zone,
  at: instantOf(day, time ?? "12:00", zone),
  ...(code ? { code } : {}),
  place,
  factId: `event:${day} ${place}`,
});

/** A flight between two codes, a day apart from the one before it. */
function leg(from: string, to: string, opts: { day?: string; arrTime?: string | undefined } = {}): Leg {
  const day = opts.day ?? "2026-11-12";
  const arrTime = "arrTime" in opts ? opts.arrTime : "20:00";
  return {
    key: `${from}-${to}-${day}`,
    mode: "flight",
    designator: `XX ${from}${to}`,
    from,
    to,
    dep: stop(from, from, day, "08:00"),
    arr: stop(to, to, day, arrTime),
    fileId: `f-${from}-${to}`,
    factIds: [],
    ask: false,
  };
}

function trainLeg(from: string, to: string): Leg {
  return {
    key: `${from}-${to}`,
    mode: "train",
    designator: "Alfa 123",
    from,
    to,
    dep: stop(undefined, from, "2026-11-12", "09:00", "Europe/Lisbon"),
    arr: stop(undefined, to, "2026-11-12", "12:00", "Europe/Lisbon"),
    fileId: "f-train",
    factIds: [],
    ask: false,
  };
}

/** A trip view holding these legs, its places looked up as tripViewOf does. */
async function viewWith(legs: Leg[], code = legs[0]?.to): Promise<TripView> {
  const coords: Record<string, LatLon> = {};
  const cities: Record<string, string> = {};
  for (const c of new Set(legs.flatMap((l) => [l.dep?.code, l.arr?.code]))) {
    const airport = c ? await lookupAirport(c) : null;
    if (airport) {
      coords[c!] = { lat: airport.lat, lon: airport.lon };
      cities[c!] = airport.city;
    }
  }
  return {
    tag: "trip:test",
    title: "Test",
    city: (code && cities[code]) || "Somewhere",
    ...(code && coords[code] ? { code, place: coords[code] } : {}),
    zone: "UTC",
    start: "2026-11-12",
    end: "2026-11-16",
    legs,
    stays: [],
    booked: [],
    international: true,
    memberIds: [],
    sources: { email: 0, pdf: 0, other: 0 },
    exact: true,
    leaveBy: legs.map(() => null),
    cities,
    coords,
  };
}

describe("the route", () => {
  it("San Francisco to Lisbon is about 9,120 km and bends north", () => {
    expect(Math.abs(distanceKm(SFO, LIS) - 9120)).toBeLessThan(20);
    const mid = greatCircle(SFO, LIS)[50]!;
    expect(mid.lat).toBeGreaterThan(54);
  });

  it("a route across the date line stays in one piece", async () => {
    const route = routeOf(await viewWith([leg("NRT", "LAX")]), NOW)!;
    const lons = route.lines[0]!.points.map((p) => p.lon);
    for (let i = 1; i < lons.length; i++) {
      expect(Math.abs(lons[i]! - lons[i - 1]!)).toBeLessThan(10);
    }
    expect(route.bounds.lon1 - route.bounds.lon0).toBeLessThan(180);
  });

  it("a round trip is one line, measured one way", () => {
    const route = routeOf(lisbonView, NOW)!;
    expect(route.lines).toHaveLength(1);
    expect(route.km).toBe(Math.round(distanceKm(lisbonView.coords.SFO!, lisbonView.coords.LIS!) / 10) * 10);
    expect(route.outMinutes).toBe(11 * 60 + 55);
    expect(route.origin).toMatchObject({ code: "SFO", city: "San Francisco" });
    expect(route.destination).toMatchObject({ code: "LIS", city: "Lisbon" });
  });

  it("a connection draws each leg and marks the stop", async () => {
    const view = await viewWith([leg("LAX", "JFK"), leg("JFK", "LIS"), leg("LIS", "LAX", { day: "2026-11-16" })], "LIS");
    const route = routeOf(view, NOW)!;
    expect(route.lines).toHaveLength(3);
    expect(route.stops).toHaveLength(1);
    expect(route.stops[0]!.lat).toBeCloseTo(40.64, 1);
  });

  it("the flight in the air is drawn up to where it is", () => {
    const out = lisbonView.legs[0]!;
    const half = (out.dep!.at + out.arr!.at) / 2;
    expect(routeOf(lisbonView, half)!.lines[0]!.inAir).toBeCloseTo(0.5, 2);
    expect(routeOf(lisbonView, NOW)!.lines[0]!.inAir).toBeUndefined();
  });

  it("no located place, no route", async () => {
    expect(routeOf(await viewWith([trainLeg("Porto Campanha", "Lisboa Oriente")]), NOW)).toBeNull();
  });

  it("the time out comes only from printed times", async () => {
    expect(routeOf(await viewWith([leg("SFO", "LIS", { arrTime: undefined })]), NOW)!.outMinutes).toBeUndefined();
  });
});
