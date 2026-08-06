import { describe, expect, it } from "vitest";
import { lookupAirport } from "./airports";
import rows from "./tables/airports.json";

describe("lookupAirport", () => {
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
