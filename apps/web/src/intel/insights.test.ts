import { describe, expect, it } from "vitest";
import { insightsFor, tripChecks, type TripWindow } from "./insights";
import type { Fact } from "./facts";

const NOW = Date.UTC(2026, 7, 4);

const fact = (over: Partial<Fact>): Fact => ({
  id: "x",
  kind: "expiry",
  document: "other",
  value: "2027-01-01",
  source: "label",
  confidence: 0.7,
  confirmed: true,
  ...over,
});

const file = (id: string, name: string, facts: Fact[]) => ({ id, name, facts });

const ruleIds = (files: Parameters<typeof insightsFor>[0]) =>
  insightsFor(files, NOW).map((insight) => insight.ruleId);

describe("passport validity", () => {
  it("warns that a passport stops being useful before it expires", () => {
    const out = insightsFor(
      [file("f1", "passport.pdf", [fact({ document: "passport", value: "2027-02-14" })])],
      NOW,
    );
    const rule = out.find((i) => i.ruleId === "passport-six-months");
    expect(rule).toBeDefined();
    // The date it stops being useful is six months before the printed one and
    // appears on no document the owner has, so it belongs in the headline
    // rather than in reasoning nobody expands.
    expect(rule!.title).toContain("14 Aug 2026");
    expect(rule!.text).toContain("six months");
    expect(rule!.fileId).toBe("f1");
  });

  it("says nothing about a passport with years left on it", () => {
    expect(ruleIds([file("f1", "p.pdf", [fact({ document: "passport", value: "2031-02-14" })])]))
      .not.toContain("passport-six-months");
  });
});

describe("cross-document rules", () => {
  it("notices a permit that outlives the passport it is attached to", () => {
    const out = insightsFor(
      [
        file("f1", "passport.pdf", [fact({ document: "passport", value: "2027-06-01" })]),
        file("f2", "permit.pdf", [fact({ document: "residence-permit", value: "2028-06-01" })]),
      ],
      NOW,
    );
    const rule = out.find((i) => i.ruleId === "permit-outlives-passport");
    expect(rule).toBeDefined();
    expect(rule!.fileId).toBe("f2");
  });

  it("stays quiet when the passport outlasts the permit", () => {
    const out = ruleIds([
      file("f1", "passport.pdf", [fact({ document: "passport", value: "2030-06-01" })]),
      file("f2", "permit.pdf", [fact({ document: "residence-permit", value: "2028-06-01" })]),
    ]);
    expect(out).not.toContain("permit-outlives-passport");
  });

  it("notices an insurance period that ended with nothing newer stored", () => {
    const out = insightsFor(
      [file("f1", "policy-2025.pdf", [fact({ document: "insurance", value: "2026-07-14" })])],
      NOW,
    );
    expect(out.find((i) => i.ruleId === "insurance-lapsed")!.severity).toBe("overdue");
  });

  it("stays quiet once a newer policy exists", () => {
    const out = ruleIds([
      file("f1", "policy-2025.pdf", [fact({ document: "insurance", value: "2026-07-14" })]),
      file("f2", "policy-2026.pdf", [fact({ document: "insurance", value: "2027-07-14" })]),
    ]);
    expect(out).not.toContain("insurance-lapsed");
  });
});

describe("simple deadline rules", () => {
  it("warns about a warranty about to end", () => {
    const out = insightsFor(
      [file("f1", "dishwasher.pdf", [fact({ document: "warranty", value: "2026-08-26" })])],
      NOW,
    );
    expect(out.find((i) => i.ruleId === "warranty-ending")).toMatchObject({ severity: "soon" });
  });

  it("says nothing about a warranty with a year left", () => {
    expect(ruleIds([file("f1", "d.pdf", [fact({ document: "warranty", value: "2027-08-26" })])]))
      .not.toContain("warranty-ending");
  });

  it("flags an invoice past its due date", () => {
    const out = insightsFor(
      [file("f1", "inv.pdf", [fact({ kind: "due", document: "invoice", value: "2026-07-23" })])],
      NOW,
    );
    expect(out.find((i) => i.ruleId === "invoice-overdue")).toMatchObject({ severity: "overdue" });
  });
});

describe("what the rules will and will not read", () => {
  it("ignores facts the owner has not confirmed when applying a rule", () => {
    const out = ruleIds([
      file("f1", "p.pdf", [fact({ document: "passport", value: "2027-02-14", confirmed: false })]),
    ]);
    expect(out).not.toContain("passport-six-months");
  });

  it("ignores a fact the owner dismissed", () => {
    const out = ruleIds([
      file("f1", "p.pdf", [
        fact({ document: "passport", value: "2027-02-14", dismissed: true }),
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("says nothing at all about an empty library", () => {
    expect(insightsFor([], NOW)).toEqual([]);
  });
});

describe("ordering and identity", () => {
  it("puts what is already overdue above what is merely coming", () => {
    const out = insightsFor(
      [
        file("f1", "warranty.pdf", [fact({ document: "warranty", value: "2026-08-26" })]),
        file("f2", "inv.pdf", [fact({ kind: "due", document: "invoice", value: "2026-07-23" })]),
      ],
      NOW,
    );
    expect(out[0]!.severity).toBe("overdue");
  });

  it("gives every insight a stable identity, so a dismissal can be remembered", () => {
    const files = [file("f1", "p.pdf", [fact({ document: "passport", value: "2027-02-14" })])];
    expect(insightsFor(files, NOW)[0]!.id).toBe(insightsFor(files, NOW)[0]!.id);
    expect(insightsFor(files, NOW)[0]!.id).toContain("f1");
  });
});

describe("travel rules", () => {
  // A confirmed September trip: out on the 10th, back on the 18th.
  const trip = (over: Partial<Fact> = {}) => [
    fact({ kind: "event", value: "2026-09-10", label: "Flight AQ 214 departs SFO", time: "09:40", ...over }),
    fact({ kind: "event", value: "2026-09-10", label: "Flight AQ 214 arrives JFK", ...over }),
    fact({ kind: "event", value: "2026-09-18", label: "Flight AQ 215 departs JFK", ...over }),
  ];

  it("says when a trip returns inside the passport's six-month window", () => {
    const files = [
      file("fp", "passport.pdf", [fact({ document: "passport", value: "2027-01-02" })]),
      file("ft", "flights.html", trip()),
    ];
    const out = insightsFor(files, NOW).find((i) => i.ruleId === "passport-short-for-trip");
    expect(out).toBeDefined();
    expect(out!.severity).toBe("soon");
    expect(out!.text).toContain("18 Sep 2026");
    expect(out!.text).toContain("2 Jan 2027");
  });

  it("escalates when the passport expires during the trip itself", () => {
    const files = [
      file("fp", "passport.pdf", [fact({ document: "passport", value: "2026-09-15" })]),
      file("ft", "flights.html", trip()),
    ];
    const out = insightsFor(files, NOW).find((i) => i.ruleId === "passport-short-for-trip");
    expect(out!.severity).toBe("overdue");
    expect(out!.title).toBe("Passport expires during this trip");
  });

  it("stays entirely quiet about trips built on unconfirmed events", () => {
    const files = [
      file("fp", "passport.pdf", [fact({ document: "passport", value: "2026-10-01" })]),
      file("ft", "flights.html", trip({ confirmed: false })),
    ];
    expect(ruleIds(files)).not.toContain("passport-short-for-trip");
  });

  it("notices a permit that dies mid-trip", () => {
    const files = [
      file("fv", "visa.pdf", [fact({ document: "visa", value: "2026-09-12" })]),
      file("ft", "flights.html", trip()),
    ];
    const out = insightsFor(files, NOW).find((i) => i.ruleId === "permit-ends-mid-trip");
    expect(out).toBeDefined();
    expect(out!.fileId).toBe("fv");
  });

  it("sees the night between landing and check-in", () => {
    const files = [
      file("ft", "flight.html", [
        fact({ kind: "event", value: "2026-09-10", label: "Flight AQ 214 arrives JFK" }),
      ]),
      file("fh", "hotel.html", [
        fact({ kind: "event", value: "2026-09-11", label: "Check-in: The Larkspur Hotel" }),
      ]),
    ];
    const out = insightsFor(files, NOW).find((i) => i.ruleId === "checkin-gap");
    expect(out).toBeDefined();
    expect(out!.fileId).toBe("fh");
    expect(out!.text).toContain("10 Sep 2026");
  });

  it("keeps quiet when the room starts the day you land", () => {
    const files = [
      file("ft", "flight.html", [
        fact({ kind: "event", value: "2026-09-10", label: "Flight arrives JFK" }),
      ]),
      file("fh", "hotel.html", [fact({ kind: "event", value: "2026-09-10", label: "Check-in: Inn" })]),
    ];
    expect(ruleIds(files)).not.toContain("checkin-gap");
  });

  it("mentions check-in opening exactly the day before the flight", () => {
    const files = [
      file("ft", "pass.pdf", [
        fact({ kind: "event", value: "2026-08-05", label: "Flight AQ 214 departs SFO", time: "09:40" }),
      ]),
    ];
    const out = insightsFor(files, NOW).find((i) => i.ruleId === "checkin-opens");
    expect(out).toBeDefined();
    expect(out!.text).toContain("09:40");
    const dayOf = insightsFor(files, Date.UTC(2026, 7, 5)).map((i) => i.ruleId);
    expect(dayOf).not.toContain("checkin-opens");
  });
});

describe("facts that count without a yes", () => {
  it("insights read an accepted passport expiry", () => {
    const passport = fact({ document: "passport", value: "2027-02-14", confirmed: undefined, source: "mrz", confidence: 1, accepted: "exact" });
    expect(ruleIds([file("f1", "passport.pdf", [passport])])).toContain("passport-six-months");
    const offered = fact({ document: "passport", value: "2027-02-14", confirmed: undefined });
    expect(ruleIds([file("f1", "passport.pdf", [offered])])).not.toContain("passport-six-months");
  });
});

describe("rules read what each date is", () => {
  it("a flight landing tomorrow does not say check-in opens", () => {
    const files = [file("ft", "flight.html", [fact({ kind: "event", value: "2026-08-05", label: "Flight AQ 214 arrives JFK", time: "18:05" })])];
    expect(ruleIds(files)).not.toContain("checkin-opens");
  });
});

describe("one set of trip checks for the bell and the hero", () => {
  const NOW_TRIP = Date.UTC(2026, 9, 26);
  const window = (over: Partial<TripWindow> = {}): TripWindow => ({
    tag: "trip:lisbon-2026-11",
    start: "2026-11-12",
    end: "2026-11-16",
    international: true,
    memberIds: ["booking", "policy"],
    firstArrival: { day: "2026-11-13", time: "14:05" },
    stays: [{ name: "Casa do Rio", checkIn: { day: "2026-11-13", time: "15:00" }, checkOut: { day: "2026-11-16" }, fileId: "hotel" }],
    overnightLegs: ["2026-11-12"],
    ...over,
  });

  it("the nights and landing lines open the stay's confirmation", () => {
    const checks = tripChecks(window(), [], NOW_TRIP);
    expect(line(checks, "checkin-gap")!.fileId).toBe("hotel");
    expect(line(checks, "lands-before-checkin")!.fileId).toBe("hotel");
  });
  const passport = (value: string) => file("pp", "passport.pdf", [fact({ document: "passport", value })]);
  const policy = (value: string) => file("policy", "travel-policy.pdf", [fact({ document: "insurance", value })]);
  const line = (checks: ReturnType<typeof tripChecks>, ruleId: string) => checks.find((check) => check.ruleId === ruleId);

  it("a passport good for months past the return is OK", () => {
    expect(line(tripChecks(window(), [passport("2029-03-20")], NOW_TRIP), "passport-short-for-trip")).toMatchObject({
      state: "ok",
      title: "Passport valid to Mar 2029",
      text: "Well past your return on 16 Nov",
      fileId: "pp",
    });
  });

  it("a passport inside six months is a note", () => {
    expect(line(tripChecks(window(), [passport("2027-03-01")], NOW_TRIP), "passport-short-for-trip")).toMatchObject({
      state: "note",
      title: "Passport expires 1 Mar 2027",
      text: "Inside six months of your return on 16 Nov",
    });
  });

  it("a passport that runs out during the trip is a warning", () => {
    expect(line(tripChecks(window(), [passport("2026-11-14")], NOW_TRIP), "passport-short-for-trip")).toMatchObject({
      state: "warn",
      title: "Passport expires during this trip",
    });
  });

  it("a domestic trip asks nothing about passports, on the bell or the hero", () => {
    const domestic = window({ international: false });
    expect(line(tripChecks(domestic, [passport("2027-03-01")], NOW_TRIP), "passport-short-for-trip")).toBeUndefined();
    expect(insightsFor([passport("2027-03-01")], NOW_TRIP, [domestic]).map((insight) => insight.ruleId)).not.toContain("passport-short-for-trip");
  });

  it("insurance through the return is OK and names its file", () => {
    expect(line(tripChecks(window(), [policy("2026-11-17")], NOW_TRIP), "insurance-short-for-trip")).toMatchObject({
      state: "ok",
      title: "Travel insurance valid to 17 Nov",
      text: "From travel-policy.pdf",
      fileId: "policy",
    });
    expect(line(tripChecks(window(), [policy("2026-11-15")], NOW_TRIP), "insurance-short-for-trip")).toMatchObject({
      state: "note",
      title: "Travel insurance ends 15 Nov, before your return",
    });
  });

  it("a policy that is not part of the trip is not its travel insurance", () => {
    expect(line(tripChecks(window({ memberIds: ["booking"] }), [policy("2026-11-17")], NOW_TRIP), "insurance-short-for-trip")).toBeUndefined();
  });

  it("every night covered by a flight and a hotel is OK", () => {
    expect(line(tripChecks(window(), [], NOW_TRIP), "checkin-gap")).toMatchObject({
      state: "ok",
      title: "Every night has a place to sleep",
      text: "12 Nov on the plane, then 3 nights at Casa do Rio",
    });
  });

  it("a night with no stay is a note", () => {
    const late = window({ stays: [{ name: "Casa do Rio", checkIn: { day: "2026-11-14", time: "15:00" }, checkOut: { day: "2026-11-16" } }] });
    expect(line(tripChecks(late, [], NOW_TRIP), "checkin-gap")).toMatchObject({ state: "note", title: "1 night has no stay stored", text: "13 Nov" });
  });

  it("landing before check-in is a note", () => {
    expect(line(tripChecks(window(), [], NOW_TRIP), "lands-before-checkin")).toMatchObject({
      state: "note",
      title: "You land at 14:05; check-in opens at 15:00",
    });
    expect(line(tripChecks(window({ firstArrival: { day: "2026-11-13", time: "16:30" } }), [], NOW_TRIP), "lands-before-checkin")).toBeUndefined();
  });

  it("the checks come in the order passport, insurance, nights, landing", () => {
    expect(tripChecks(window(), [passport("2029-03-20"), policy("2026-11-17")], NOW_TRIP).map((check) => check.ruleId)).toEqual([
      "passport-short-for-trip",
      "insurance-short-for-trip",
      "checkin-gap",
      "lands-before-checkin",
    ]);
  });

  it("the bell and the hero agree on the same trip", () => {
    const files = [passport("2027-03-01"), policy("2026-11-15")];
    const late = window({ stays: [{ name: "Casa do Rio", checkIn: { day: "2026-11-14" }, checkOut: { day: "2026-11-16" } }] });
    const hero = tripChecks(late, files, NOW_TRIP)
      .filter((check) => check.state !== "ok")
      .map((check) => check.title)
      .sort();
    const tripRules = new Set(tripChecks(late, files, NOW_TRIP).map((check) => check.ruleId));
    const bell = insightsFor(files, NOW_TRIP, [late])
      .filter((insight) => tripRules.has(insight.ruleId))
      .map((insight) => insight.title)
      .sort();
    expect(hero.length).toBeGreaterThan(0);
    expect(bell).toEqual(hero);
  });
});

describe("the bell's trip checks", () => {
  const NOW_TRIP = Date.UTC(2026, 9, 26);
  const window = (over: Partial<TripWindow> = {}): TripWindow => ({
    tag: "trip:lisbon-2026-11",
    start: "2026-11-12",
    end: "2026-11-16",
    international: true,
    memberIds: [],
    stays: [],
    overnightLegs: [],
    ...over,
  });
  const passport = file("pp", "passport.pdf", [fact({ document: "passport", value: "2027-03-01" })]);
  const passportIds = (views: TripWindow[], files = [passport]) =>
    insightsFor(files, NOW_TRIP, views)
      .filter((insight) => insight.ruleId === "passport-short-for-trip")
      .map((insight) => insight.id);

  it("each trip's checks are its own on the bell", () => {
    const ids = passportIds([window(), window({ tag: "trip:porto-2026-12", start: "2026-12-01", end: "2026-12-05" })]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("a trip that is over says nothing on the bell", () => {
    const old = file("old", "old-passport.pdf", [fact({ document: "passport", value: "2026-04-03" })]);
    expect(passportIds([window({ start: "2026-04-01", end: "2026-04-05" })], [old])).toEqual([]);
  });

  it("travel no trip holds still warns about the passport when trips are read", () => {
    const flights = file("ft", "flights.html", [
      fact({ kind: "event", value: "2026-11-20", label: "Flight AQ 214 departs SFO", time: "09:40" }),
      fact({ kind: "event", value: "2026-11-20", label: "Flight AQ 214 arrives JFK" }),
      fact({ kind: "event", value: "2026-11-28", label: "Flight AQ 215 departs JFK" }),
    ]);
    expect(passportIds([], [passport, flights])).toHaveLength(1);
  });

  it("a trip with no days asks nothing", () => {
    expect(tripChecks(window({ start: "", end: "" }), [passport], NOW_TRIP)).toEqual([]);
  });
});

describe("what a nights note opens", () => {
  it("an open-nights note opens no unrelated file", () => {
    const window: TripWindow = {
      tag: "trip:lisbon-2026-11",
      start: "2026-11-12",
      end: "2026-11-16",
      international: true,
      memberIds: [],
      stays: [{ name: "Casa do Rio", checkIn: { day: "2026-11-14" }, checkOut: { day: "2026-11-16" }, fileId: "hotel" }],
      overnightLegs: ["2026-11-12"],
    };
    const nights = tripChecks(window, [], Date.UTC(2026, 9, 26)).find((check) => check.ruleId === "checkin-gap")!;
    expect(nights.state).toBe("note");
    expect(nights.fileId).toBeUndefined();
  });
});
