// A zone whose clock is half an hour off the UTC hour: the start of its
// hour is not the start of a UTC hour.
process.env.TZ = "Asia/Kolkata";

import { describe, expect, it } from "vitest";
import { daysUntil } from "./dates";
import { hourOf } from "./instants";

describe("the start of the device's hour", () => {
  // 00:15 on 20 Nov 2026 in Kolkata is 18:45 on the 19th in UTC.
  const justPastMidnight = new Date("2026-11-20T00:15:00+05:30").getTime();

  it("is on the device's own clock", () => {
    expect(new Date(hourOf(justPastMidnight)).toISOString()).toBe("2026-11-19T18:30:00.000Z");
    expect(hourOf(hourOf(justPastMidnight))).toBe(hourOf(justPastMidnight));
  });

  it("never reads a day the device has left", () => {
    // Floored to the UTC hour, this would be 23:30 on the 19th, and today a day away.
    expect(daysUntil("2026-11-20", hourOf(justPastMidnight))).toBe(0);
    expect(daysUntil("2026-11-20", justPastMidnight)).toBe(0);
  });
});
