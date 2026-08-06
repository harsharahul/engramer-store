import { describe, expect, it } from "vitest";
import { insightsFor } from "./insights";
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
