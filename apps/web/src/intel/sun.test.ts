import { describe, expect, it } from "vitest";
import { skyOf, sunTimes } from "./sun";

const LIS = { lat: 38.77, lon: -9.13 };
const SFO = { lat: 37.62, lon: -122.38 };
const TOS = { lat: 69.68, lon: 18.92 };

/** Within three minutes: published tables round, and so do we. */
function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(3 * 60_000);
}

describe("sunTimes", () => {
  it("sunrise and sunset in Lisbon in November", () => {
    const t = sunTimes("2026-11-12", LIS) as { rise: number; set: number };
    near(t.rise, Date.parse("2026-11-12T07:16:00Z"));
    near(t.set, Date.parse("2026-11-12T17:25:00Z"));
  });

  it("an evening sunset in San Francisco is the next day in UTC", () => {
    const t = sunTimes("2026-09-08", SFO) as { rise: number; set: number };
    near(t.rise, Date.parse("2026-09-08T13:46:00Z"));
    near(t.set, Date.parse("2026-09-09T02:27:00Z"));
  });

  it("the polar night and the midnight sun keep one sky", () => {
    expect(sunTimes("2026-12-21", TOS)).toEqual({ polar: "night" });
    expect(sunTimes("2026-06-21", TOS)).toEqual({ polar: "day" });
    expect(skyOf(Date.parse("2026-12-21T11:00:00Z"), "Europe/Oslo", TOS)).toBe("night");
    expect(skyOf(Date.parse("2026-06-21T23:00:00Z"), "Europe/Oslo", TOS)).toBe("day");
  });
});

describe("skyOf", () => {
  it("the sky follows the sun", () => {
    const at = (t: string) => skyOf(Date.parse(`2026-11-12T${t}:00Z`), "Europe/Lisbon", LIS);
    expect([at("07:00"), at("12:00"), at("17:30"), at("20:00")]).toEqual(["dawn", "day", "dusk", "night"]);
  });

  it("a place whose clock is across the date line from its longitude has day at noon", () => {
    // Samoa keeps UTC+13 at 172° west: its local noon is the previous UTC day.
    const apia = { lat: -13.83, lon: -172.01 };
    expect(skyOf(Date.parse("2026-07-15T14:00:00+13:00"), "Pacific/Apia", apia)).toBe("day");
    expect(skyOf(Date.parse("2026-07-15T23:00:00+13:00"), "Pacific/Apia", apia)).toBe("night");
  });

  it("without coordinates the hour decides", () => {
    const at = (t: string) => skyOf(Date.parse(`2026-09-08T${t}:00-07:00`), "America/Los_Angeles");
    expect([at("05:30"), at("08:40"), at("18:00"), at("21:00")]).toEqual(["dawn", "day", "dusk", "night"]);
  });
});
