import { describe, expect, it } from "vitest";
import { withExactAcceptance, type Fact } from "./facts";
import { legsOf, type DatedEntry } from "./legs";
import { departureAdvice } from "./trips";

let seq = 0;
const exact = (value: string, label: string, extra: Partial<Fact> = {}): Fact =>
  withExactAcceptance({
    id: `event:${value} ${label.toLowerCase()} ${seq++}`,
    kind: "event",
    document: "itinerary",
    value,
    label,
    source: "jsonld",
    confidence: 1,
    ...extra,
  });
const entries = (fileId: string, facts: Fact[], ask = false): DatedEntry[] => facts.map((fact) => ({ fileId, fact, ask }));
// As the barcode states it: the flight, both airports, a date whose year is inferred.
const pass = (value: string): Fact => ({
  id: `event:${value} tp236`,
  kind: "event",
  document: "boarding-pass",
  value,
  label: "Flight TP 236 SFO to LIS",
  source: "barcode",
  confidence: 0.6,
});
const booking = () =>
  entries("booking", [
    exact("2026-11-12", "Flight TP 236 departs SFO", { time: "18:10" }),
    exact("2026-11-13", "Flight TP 236 arrives LIS", { time: "14:05" }),
    exact("2026-11-16", "Flight TP 237 departs LIS", { time: "13:20" }),
    exact("2026-11-16", "Flight TP 237 arrives SFO", { time: "17:05" }),
  ]);

describe("legsOf", () => {
  it("a booking's flights become legs with their instants", async () => {
    const legs = await legsOf(booking());
    expect(legs.map((leg) => [leg.designator, leg.from, leg.to])).toEqual([
      ["TP 236", "SFO", "LIS"],
      ["TP 237", "LIS", "SFO"],
    ]);
    expect(legs[0]!.dep).toMatchObject({ day: "2026-11-12", time: "18:10", zone: "America/Los_Angeles", at: Date.UTC(2026, 10, 13, 2, 10) });
    expect(legs[0]!.arr).toMatchObject({ day: "2026-11-13", time: "14:05", zone: "Europe/Lisbon", at: Date.UTC(2026, 10, 13, 14, 5) });
  });

  it("a round trip on one designator pairs each departure with its arrival", async () => {
    const legs = await legsOf(
      entries("bus", [
        exact("2027-06-08", "Bus FlixBus departs Porto", { time: "08:15" }),
        exact("2027-06-08", "Bus FlixBus arrives Lisbon", { time: "11:40" }),
        exact("2027-06-12", "Bus FlixBus departs Lisbon", { time: "17:00" }),
        exact("2027-06-12", "Bus FlixBus arrives Porto", { time: "20:30" }),
      ]),
    );
    expect(legs.map((leg) => [leg.from, leg.dep?.time, leg.to, leg.arr?.time])).toEqual([
      ["Porto", "08:15", "Lisbon", "11:40"],
      ["Lisbon", "17:00", "Porto", "20:30"],
    ]);
  });

  it("legs of one reservation pair by it, not by order", async () => {
    const legs = await legsOf(
      entries("booking", [
        exact("2026-11-12", "Flight TP 236 departs SFO", { time: "18:10", subject: { role: "depart", mode: "flight", carrier: "TP", number: "236", code: "SFO", reservation: 0 } }),
        exact("2026-11-12", "Flight TP 236 departs SFO", { time: "21:00", subject: { role: "depart", mode: "flight", carrier: "TP", number: "236", code: "SFO", reservation: 1 } }),
        exact("2026-11-13", "Flight TP 236 arrives LIS", { time: "14:05", subject: { role: "arrive", mode: "flight", carrier: "TP", number: "236", code: "LIS", reservation: 0 } }),
      ]),
    );
    expect(legs.map((leg) => [leg.dep?.time, leg.arr?.time])).toEqual([
      ["18:10", "14:05"],
      ["21:00", undefined],
    ]);
  });

  it("a flight that lands at an earlier printed clock than it left is still one leg", async () => {
    // Tokyo 17:00 to Los Angeles 11:00 the same printed day, eleven hours later.
    const [leg, ...rest] = await legsOf(
      entries("pacific", [
        exact("2026-11-12", "Flight NH 6 departs HND", { time: "17:00", zone: "+09:00" }),
        exact("2026-11-12", "Flight NH 6 arrives LAX", { time: "11:00", zone: "-08:00" }),
      ]),
    );
    expect(rest).toEqual([]);
    expect(leg).toMatchObject({ from: "HND", to: "LAX" });
    expect(leg!.arr!.at - leg!.dep!.at).toBe(11 * 3_600_000);
  });

  it("a flight that lands at the same printed clock it left is still one leg", async () => {
    // Helsinki 08:00 to Stockholm 08:00, an hour later.
    const [leg, ...rest] = await legsOf(
      entries("baltic", [
        exact("2026-11-12", "Flight AY 641 arrives ARN", { time: "08:00", zone: "+01:00" }),
        exact("2026-11-12", "Flight AY 641 departs HEL", { time: "08:00", zone: "+02:00" }),
      ]),
    );
    expect(rest).toEqual([]);
    expect(leg).toMatchObject({ from: "HEL", to: "ARN" });
  });

  it("legs of one reservation pair by it whatever their printed order", async () => {
    const said = (role: "depart" | "arrive", code: string, reservation: number) =>
      ({ role, mode: "flight", carrier: "NH", number: "6", code, reservation }) as const;
    const legs = await legsOf(
      entries("pacific", [
        exact("2026-11-12", "Flight NH 6 departs HND", { time: "17:00", zone: "+09:00", subject: said("depart", "HND", 0) }),
        exact("2026-11-12", "Flight NH 6 arrives LAX", { time: "11:00", zone: "-08:00", subject: said("arrive", "LAX", 0) }),
      ]),
    );
    expect(legs.map((leg) => [leg.from, leg.to])).toEqual([["HND", "LAX"]]);
  });

  it("a boarding pass for a booked flight joins that flight", async () => {
    const legs = await legsOf([...booking(), ...entries("pass", [pass("2026-11-12")], true)]);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ designator: "TP 236", fileId: "booking", passFileId: "pass", ask: false });
  });

  it("a boarding pass alone is a flight that still asks", async () => {
    const [leg, ...rest] = await legsOf(entries("pass", [pass("2026-11-12")], true));
    expect(rest).toEqual([]);
    expect(leg).toMatchObject({ designator: "TP 236", from: "SFO", to: "LIS", fileId: "pass", ask: true });
    expect(leg!.dep).toMatchObject({ day: "2026-11-12", zone: "America/Los_Angeles" });
    expect(leg!.dep!.time).toBeUndefined();
    expect(leg!.passFileId).toBeUndefined();
  });
});

describe("departureAdvice", () => {
  it("leave-by is three hours before an international departure, in its own zone", async () => {
    const [out] = await legsOf(booking());
    expect(await departureAdvice(out!)).toEqual({ at: Date.UTC(2026, 10, 12, 23, 10), zone: "America/Los_Angeles", hours: 3, international: true });
  });

  it("leave-by for a 01:30 departure is the evening before", async () => {
    const [late] = await legsOf(
      entries("late", [
        exact("2026-11-20", "Flight TP 999 departs LIS", { time: "01:30" }),
        exact("2026-11-20", "Flight TP 999 arrives SFO", { time: "05:10" }),
      ]),
    );
    const advice = await departureAdvice(late!);
    expect(advice).toMatchObject({ hours: 3, zone: "Europe/Lisbon" });
    expect(advice!.at).toBe(Date.UTC(2026, 10, 19, 22, 30)); // 22:30 in Lisbon the day before
  });

  it("stays quiet when an airport cannot be placed or the time is unknown", async () => {
    const [unknown] = await legsOf(
      entries("x", [exact("2026-11-20", "Flight ZZ 1 departs QQQ", { time: "09:00" }), exact("2026-11-20", "Flight ZZ 1 arrives SFO", { time: "11:00" })]),
    );
    expect(await departureAdvice(unknown!)).toBeNull();
    const [untimed] = await legsOf(entries("pass", [pass("2026-11-12")], true));
    expect(await departureAdvice(untimed!)).toBeNull();
  });
});
