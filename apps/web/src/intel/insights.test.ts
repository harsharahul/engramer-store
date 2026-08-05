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
