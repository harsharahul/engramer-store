import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { airportForCity, lookupAirport } from "./airports";
import rows from "./tables/airports.json";

describe("lookupAirport", () => {
  it("an airport carries where it is", async () => {
    const lis = await lookupAirport("LIS");
    expect(lis?.lat).toBeCloseTo(38.77, 1);
    expect(lis?.lon).toBeCloseTo(-9.13, 1);
    const sfo = await lookupAirport("SFO");
    expect(sfo?.lat).toBeCloseTo(37.62, 1);
    expect(sfo?.lon).toBeCloseTo(-122.38, 1);
  });

  it("a code bookings already name stays known after the data is rebuilt", async () => {
    // Renamed upstream (PBI is listed as DJT now) or no longer scheduled:
    // past and future bookings still say these codes.
    expect(await lookupAirport("PBI")).toMatchObject({ city: "West Palm Beach", zone: "America/New_York" });
    expect((await lookupAirport("PBI"))?.lat).toBeCloseTo(26.68, 1);
    for (const code of ["LWO", "DKR", "LAD", "LBG"]) {
      expect(await lookupAirport(code)).not.toBeNull();
    }
  });

  it("the airports table stays small enough to load on a phone", () => {
    expect(statSync(fileURLToPath(new URL("./tables/airports.json", import.meta.url))).size).toBeLessThan(260_000);
  });

  it("names the city and zone for a code", async () => {
    expect(await lookupAirport("JFK")).toMatchObject({
      city: "New York",
      country: "US",
      zone: "America/New_York",
    });
  });

  it("is case-insensitive and strict about shape", async () => {
    expect((await lookupAirport("sfo"))!.zone).toBe("America/Los_Angeles");
    expect(await lookupAirport("XXXX")).toBeNull();
    expect(await lookupAirport("")).toBeNull();
  });

  it("answers null for a code the table does not carry", async () => {
    // QQQ is outside IATA's assignment ranges.
    expect(await lookupAirport("QQQ")).toBeNull();
  });

  it("ships a plausible table", () => {
    const table = rows as unknown as [string, string, string, string][];
    expect(table.length).toBeGreaterThan(2000);
    for (const [code, city, , zone] of table) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(city.length).toBeGreaterThan(0);
      expect(zone).toMatch(/^[A-Za-z_+-]+(?:\/[A-Za-z_+-]+){1,2}$/);
    }
  });
});

describe("airportForCity", () => {
  it("finds a city's airport, or none", async () => {
    expect((await airportForCity("Lisbon"))?.code).toBe("LIS");
    expect((await airportForCity("lisbon"))?.code).toBe("LIS");
    expect(await airportForCity("Nowhere at all")).toBeNull();
  });
});
