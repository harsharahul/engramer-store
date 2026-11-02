import { describe, expect, it } from "vitest";
import type { Fact } from "./facts";
import { deviceZone, instantOf, zoneOf } from "./instants";

describe("instantOf", () => {
  it("a printed offset is used as written", () => {
    expect(instantOf("2026-11-12", "18:10", "-08:00")).toBe(Date.UTC(2026, 10, 13, 2, 10));
    expect(instantOf("2026-11-13", "14:05", "+00:00")).toBe(Date.UTC(2026, 10, 13, 14, 5));
    expect(instantOf("2026-11-13", "14:05", "UTC")).toBe(Date.UTC(2026, 10, 13, 14, 5));
    expect(instantOf("2026-11-13", "09:30", "+05:30")).toBe(Date.UTC(2026, 10, 13, 4, 0));
  });

  it("a named zone follows its summer and winter time", () => {
    expect(instantOf("2026-03-31", "09:00", "Europe/Lisbon")).toBe(Date.UTC(2026, 2, 31, 8, 0));
    expect(instantOf("2026-11-10", "09:00", "Europe/Lisbon")).toBe(Date.UTC(2026, 10, 10, 9, 0));
    expect(instantOf("2026-11-12", "18:10", "America/Los_Angeles")).toBe(Date.UTC(2026, 10, 13, 2, 10));
    expect(instantOf("2026-09-08", "19:30", "America/Los_Angeles")).toBe(Date.UTC(2026, 8, 9, 2, 30));
  });

  it("an overnight westbound arrival keeps its own instant", () => {
    // Leaves Lisbon 13:20 and lands in San Francisco 17:05 the same printed day, 11 h 45 m later.
    const leaves = instantOf("2026-11-16", "13:20", "Europe/Lisbon");
    const lands = instantOf("2026-11-16", "17:05", "America/Los_Angeles");
    expect(lands - leaves).toBe((11 * 60 + 45) * 60_000);
  });

  it("no time is the start of the day in that zone", () => {
    expect(instantOf("2026-11-13", undefined, "Europe/Lisbon")).toBe(Date.UTC(2026, 10, 13, 0, 0));
    expect(instantOf("2026-11-13", undefined, "-08:00")).toBe(Date.UTC(2026, 10, 13, 8, 0));
  });

  it("a zone this device cannot read falls back to the device", () => {
    expect(instantOf("2026-11-13", "09:00", "Mars/Olympus")).toBe(new Date(2026, 10, 13, 9, 0).getTime());
  });
});

describe("zoneOf", () => {
  const fact = (over: Partial<Fact>): Fact => ({
    id: "event:x",
    kind: "event",
    document: "itinerary",
    value: "2026-11-13",
    source: "jsonld",
    confidence: 1,
    ...over,
  });

  it("a printed zone wins", async () => {
    expect(await zoneOf(fact({ zone: "-08:00", label: "Flight TP 236 departs SFO" }), { tripZone: "Europe/Lisbon" })).toBe("-08:00");
  });

  it("a stop takes its own airport's zone", async () => {
    expect(await zoneOf(fact({ label: "Flight TP 236 arrives LIS" }), { tripZone: "America/New_York" })).toBe("Europe/Lisbon");
  });

  it("a hotel's times take its trip's destination zone", async () => {
    expect(await zoneOf(fact({ label: "Check-in: Casa do Rio", document: "hotel-booking" }), { tripZone: "Europe/Lisbon" })).toBe("Europe/Lisbon");
  });

  it("anything else is the device's own time", async () => {
    expect(await zoneOf(fact({ label: "Dinner" }), {})).toBe(deviceZone());
  });
});
