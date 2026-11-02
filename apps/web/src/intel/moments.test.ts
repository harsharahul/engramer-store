import { beforeAll, describe, expect, it } from "vitest";
import { email, exact, file, hotel, lisbonFiles, lisbonTrip, PLANNING_NOW } from "./__fixtures__/lisbon";
import { planTrips, tripsOf } from "./agenda";
import { rowsOf } from "./agendarows";
import { instantOf } from "./instants";
import { momentOf, posterOf } from "./moments";
import { tripViewOf, type TripView } from "./tripview";

const LA = "America/Los_Angeles";
const LIS = "Europe/Lisbon";
const at = (day: string, time: string, zone: string) => instantOf(day, time, zone);

let lisbon: TripView;
beforeAll(async () => {
  lisbon = (await lisbonTrip()).view;
});

/** A tagged trip's view read from its files alone, as the Timeline would. */
async function viewOf(files: Parameters<typeof rowsOf>[0], tag: string): Promise<TripView> {
  const plans = await planTrips(files, PLANNING_NOW);
  const tagged = files.map((member) => ({ ...member, tags: [tag] }));
  const rows = await rowsOf(tagged, { plans, dismissed: new Set(), excluded: new Set(), assembling: true }, PLANNING_NOW);
  return tripViewOf(tripsOf(tagged)[0]!, rows, { plan: plans.find((plan) => plan.tag === tag) ?? plans[0] });
}

describe("the moments of one trip", () => {
  it("26 Oct 10:00 Los Angeles is planning, 17 days out", () => {
    const now = at("2026-10-26", "10:00", LA);
    const moment = momentOf([lisbon], now);
    expect(moment).toMatchObject({ kind: "planning", daysUntil: 17 });
    expect(posterOf(moment, now, LA)).toMatchObject({
      top: "Next trip",
      city: "Lisbon",
      code: "LIS",
      big: "17 days",
      cap: "until you fly",
      meta: "Portugal · Mon 26 Oct · 17:00 in Lisbon",
      skyHour: 17,
    });
  });

  it("11 Nov 09:30 is soon, tomorrow, TP 236 in 1 d 8 h", () => {
    const now = at("2026-11-11", "09:30", LA);
    const moment = momentOf([lisbon], now);
    expect(moment).toMatchObject({ kind: "soon", daysUntil: 1, checkInOpens: Date.UTC(2026, 10, 12, 2, 10) });
    expect(posterOf(moment, now, LA)).toMatchObject({ top: "Next trip", big: "Tomorrow", cap: "TP 236 in 1 d 8 h", meta: "Portugal · Wed 11 Nov · 17:30 in Lisbon" });
  });

  it("12 Nov 13:30 is travel day, leave by 15:10", () => {
    const now = at("2026-11-12", "13:30", LA);
    const moment = momentOf([lisbon], now);
    expect(moment).toMatchObject({ kind: "travel", leaveBy: { at: Date.UTC(2026, 10, 12, 23, 10), zone: LA, code: "SFO", hours: 3, international: true } });
    expect(posterOf(moment, now, LA)).toMatchObject({ top: "Travel day", big: "Today", cap: "TP 236 departs 18:10", meta: "Portugal · Thu 12 Nov · 21:30 in Lisbon", skyHour: 21 });
  });

  it("13 Nov 06:00 Lisbon is in the air, about a third of the way, lands 14:05 Lisbon time", () => {
    const now = at("2026-11-13", "06:00", LIS);
    const moment = momentOf([lisbon], now);
    expect(moment.kind).toBe("air");
    expect(moment.flying!.leg.designator).toBe("TP 236");
    expect(moment.flying!.progress).toBeCloseTo(0.322, 2);
    expect(posterOf(moment, now, LA)).toMatchObject({ top: "TP 236 · SFO to LIS", big: "In the air", cap: "lands 14:05 Lisbon time", skyHour: 6 });
  });

  it("14 Nov 15:42 Lisbon is staying, day 3 of 5, night 2 of 3 at Casa do Rio", () => {
    const now = at("2026-11-14", "15:42", LIS);
    const moment = momentOf([lisbon], now);
    expect(moment).toMatchObject({ kind: "staying", day: { n: 3, of: 5 }, night: { n: 2, of: 3 } });
    expect(moment.night!.stay.name).toBe("Casa do Rio");
    expect(posterOf(moment, now, LA)).toMatchObject({
      top: "You are here",
      big: "Day 3 of 5",
      cap: "Night 2 of 3 at Casa do Rio",
      meta: "Portugal · Sat 14 Nov · 15:42 in Lisbon",
    });
  });

  it("16 Nov 08:30 Lisbon is the last day, leave by 10:20, flight home at 13:20", () => {
    const now = at("2026-11-16", "08:30", LIS);
    const moment = momentOf([lisbon], now);
    expect(moment).toMatchObject({ kind: "last", leaveBy: { at: Date.UTC(2026, 10, 16, 10, 20), code: "LIS", hours: 3 } });
    expect(posterOf(moment, now, LA)).toMatchObject({ top: "You are here", big: "Last day", cap: "flight home at 13:20" });
  });

  it("18 Nov 19:00 Los Angeles is back home, 5 days in Lisbon", () => {
    const now = at("2026-11-18", "19:00", LA);
    const moment = momentOf([lisbon], now);
    expect(moment.kind).toBe("home");
    expect(posterOf(moment, now, LA, { photos: 23 })).toMatchObject({
      top: "Your last trip",
      big: "Welcome back",
      cap: "5 days in Lisbon",
      meta: "Portugal · 12-16 Nov 2026 · 23 photos",
      skyHour: 19,
    });
  });

  it("22 Nov is everyday again", () => {
    const moment = momentOf([lisbon], at("2026-11-22", "09:00", LA));
    expect(moment).toEqual({ kind: "everyday" });
    expect(posterOf(moment, at("2026-11-22", "09:00", LA), LA)).toBeNull();
  });

  it("a trip 40 days out leaves the hero to the ordinary day", () => {
    expect(momentOf([lisbon], at("2026-10-03", "09:00", LA)).kind).toBe("everyday");
  });
});

describe("which trip the hero follows", () => {
  it("two trips: the one under way wins, then the nearest", async () => {
    const chicago = await viewOf(
      [
        email("ord", "2026-10-05", [
          exact("event", "2026-11-20", "Flight AQ 100 departs SFO", { time: "08:00" }),
          exact("event", "2026-11-20", "Flight AQ 100 arrives ORD", { time: "14:10" }),
          exact("event", "2026-11-23", "Flight AQ 101 departs ORD", { time: "17:00" }),
          exact("event", "2026-11-23", "Flight AQ 101 arrives SFO", { time: "19:40" }),
        ]),
      ],
      "trip:chicago-2026-11",
    );
    expect(momentOf([chicago, lisbon], at("2026-11-14", "15:42", LIS)).trip!.tag).toBe(lisbon.tag);
    expect(momentOf([chicago, lisbon], at("2026-10-26", "10:00", LA)).trip!.tag).toBe(lisbon.tag);
    // Lisbon is over and Chicago is two days away: the coming trip leads.
    expect(momentOf([lisbon, chicago], at("2026-11-18", "19:00", LA))).toMatchObject({ kind: "soon", daysUntil: 2 });
  });
});

describe("a trip's own shape", () => {
  it("a trip with no flights moves from staying to home by its stay", async () => {
    const stay = await viewOf(
      [email("hotel", "2026-10-02", hotel()), file("fado", [exact("event", "2026-11-14", "Fado night", { time: "21:00" })])],
      "trip:lisbon-2026-11",
    );
    expect(momentOf([stay], at("2026-11-14", "12:00", LIS))).toMatchObject({ kind: "staying", day: { n: 2, of: 4 }, night: { n: 2, of: 3 } });
    const lastDay = momentOf([stay], at("2026-11-16", "09:00", LIS));
    expect(lastDay.kind).toBe("last");
    expect(posterOf(lastDay, at("2026-11-16", "09:00", LIS), LA)!.cap).toBe("check-out at 11:00");
    expect(momentOf([stay], at("2026-11-17", "12:00", LIS)).kind).toBe("home");
  });

  it("a trip with no stay counts its nights in the city", async () => {
    const away = (await lisbonTrip(lisbonFiles().filter((member) => member.id !== "hotel"))).view;
    const now = at("2026-11-14", "15:42", LIS);
    expect(posterOf(momentOf([away], now), now, LA)!.cap).toBe("3 nights in Lisbon");
  });

  it("just after midnight in Lisbon, still evening at home, the day count is Lisbon's", () => {
    const moment = momentOf([lisbon], at("2026-11-15", "00:30", LIS));
    expect(moment).toMatchObject({ kind: "staying", day: { n: 4, of: 5 }, night: { n: 3, of: 3 } });
  });
});

describe("the way home", () => {
  it("the flight home is the first leg that leaves the destination", async () => {
    const files = lisbonFiles().map((member) =>
      member.id !== "booking"
        ? member
        : {
            ...member,
            facts: [
              ...member.facts.filter((fact) => !/TP 237/.test(fact.label ?? "")),
              exact("event", "2026-11-16", "Flight TP 201 departs LIS", { time: "10:00" }),
              exact("event", "2026-11-16", "Flight TP 201 arrives JFK", { time: "12:40" }),
              exact("event", "2026-11-16", "Flight AA 11 departs JFK", { time: "17:00" }),
              exact("event", "2026-11-16", "Flight AA 11 arrives SFO", { time: "20:30" }),
            ],
          },
    );
    const view = (await lisbonTrip(files)).view;
    const now = at("2026-11-16", "07:00", LIS);
    const moment = momentOf([view], now);
    expect(moment).toMatchObject({ kind: "last", leaveBy: { code: "LIS", at: Date.UTC(2026, 10, 16, 7, 0) } });
    expect(moment.next!.designator).toBe("TP 201");
    expect(posterOf(moment, now, LA)!.cap).toBe("flight home at 10:00");
  });
});

describe("what a trip does not say", () => {
  const untimed = () =>
    lisbonFiles().map((member) =>
      member.id !== "booking" ? member : { ...member, facts: member.facts.map(({ time: _time, ...fact }) => fact) },
    );

  it("a booking with dates and no times sets no clock", async () => {
    const view = (await lisbonTrip(untimed())).view;
    expect(momentOf([view], at("2026-11-12", "08:00", LA)).kind).toBe("travel");
    const soon = momentOf([view], at("2026-11-11", "09:00", LA));
    expect(soon.kind).toBe("soon");
    expect(soon.checkInOpens).toBeUndefined();
    const soonWords = posterOf(soon, at("2026-11-11", "09:00", LA), LA)!;
    expect(soonWords.cap).toBe("TP 236 on Thu 12 Nov");
    expect(soonWords.until).toBeUndefined();
    expect(posterOf(momentOf([view], at("2026-11-12", "08:00", LA)), at("2026-11-12", "08:00", LA), LA)!.cap).toBe("TP 236 leaves today");
    const last = momentOf([view], at("2026-11-16", "09:00", LIS));
    expect(last.kind).toBe("last");
    expect(posterOf(last, at("2026-11-16", "09:00", LIS), LA)!.cap).toBe("flight home today");
    expect(momentOf([view], at("2026-11-17", "12:00", LA)).kind).toBe("home");
  });

  it("no welcome back while the way home is unknown", async () => {
    const oneWay = (
      await lisbonTrip(
        lisbonFiles().map((member) => (member.id === "booking" ? { ...member, facts: member.facts.filter((fact) => !/TP 237/.test(fact.label ?? "")) } : member)),
        [],
        true,
      )
    ).view;
    expect(momentOf([oneWay], at("2026-11-16", "09:00", LIS)).kind).toBe("last");
    expect(momentOf([oneWay], at("2026-11-16", "12:00", LIS)).kind).toBe("everyday");
  });

  it("the last day is the day of the flight home", async () => {
    const early = lisbonFiles().map((member) =>
      member.id !== "hotel"
        ? member
        : { ...member, facts: member.facts.map((fact) => (/Check-out/.test(fact.label ?? "") ? { ...fact, value: "2026-11-15", id: `${fact.id}:15` } : fact)) },
    );
    const view = (await lisbonTrip(early, [], true)).view;
    expect(momentOf([view], at("2026-11-15", "12:00", LIS)).kind).toBe("staying");
    expect(momentOf([view], at("2026-11-16", "08:30", LIS)).kind).toBe("last");
  });

  it("a trip with no flight is counted until you leave", async () => {
    const stay = await viewOf([email("hotel", "2026-10-02", hotel()), file("fado", [exact("event", "2026-11-14", "Fado night", { time: "21:00" })])], "trip:lisbon-2026-11");
    const now = at("2026-10-26", "10:00", LA);
    expect(posterOf(momentOf([stay], now), now, LA)!.cap).toBe("until you leave");
  });
});

describe("between connections", () => {
  it("a connection gets no leave-by: the traveller is already airside", async () => {
    const files = [
      email("booking", "2026-10-01", [
        exact("event", "2026-11-12", "Flight AA 10 departs SFO", { time: "08:00" }),
        exact("event", "2026-11-12", "Flight AA 10 arrives JFK", { time: "16:30" }),
        exact("event", "2026-11-12", "Flight TP 202 departs JFK", { time: "18:30" }),
        exact("event", "2026-11-13", "Flight TP 202 arrives LIS", { time: "06:40" }),
        exact("event", "2026-11-16", "Flight TP 201 departs LIS", { time: "11:00" }),
        exact("event", "2026-11-16", "Flight TP 201 arrives SFO", { time: "15:00" }),
      ]),
      email("hotel", "2026-10-02", hotel()),
    ];
    const view = (await lisbonTrip(files)).view;
    const moment = momentOf([view], at("2026-11-12", "17:00", "America/New_York"));
    expect(moment.kind).toBe("travel");
    expect(moment.leaveBy).toBeUndefined();
  });
});
