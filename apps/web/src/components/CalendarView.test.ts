import { describe, expect, it } from "vitest";
import { laneTrips } from "./CalendarView";

const trip = (tag: string, start: string, end: string) => ({
  tag,
  title: tag,
  start,
  end,
});

describe("laneTrips", () => {
  it("stacks overlapping trips into separate lanes", () => {
    const lanes = laneTrips([
      trip("a", "2027-03-04", "2027-03-09"),
      trip("b", "2027-03-07", "2027-03-12"),
    ]);
    expect(lanes.find((t) => t.tag === "a")!.lane).toBe(0);
    expect(lanes.find((t) => t.tag === "b")!.lane).toBe(1);
  });

  it("reuses a lane once its previous occupant has ended", () => {
    const lanes = laneTrips([
      trip("a", "2027-03-04", "2027-03-09"),
      trip("b", "2027-03-10", "2027-03-14"),
    ]);
    expect(lanes.every((t) => t.lane === 0)).toBe(true);
  });

  it("gives the longer trip the lower lane when two start together", () => {
    const lanes = laneTrips([
      trip("short", "2027-03-04", "2027-03-05"),
      trip("long", "2027-03-04", "2027-03-12"),
    ]);
    expect(lanes.find((t) => t.tag === "long")!.lane).toBe(0);
    expect(lanes.find((t) => t.tag === "short")!.lane).toBe(1);
  });
});
