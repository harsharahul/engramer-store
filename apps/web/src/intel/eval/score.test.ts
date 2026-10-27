import { describe, expect, it } from "vitest";
import type { Fact } from "../facts";
import { scoreKinds, scoreReader, type EvalCase } from "./score";

const evalCase = (id: string, expected: EvalCase["expected"], mailKind?: string): EvalCase => ({
  id,
  name: `${id}.email`,
  mime: "application/vnd.engram.email+json",
  text: "synthetic",
  expected,
  ...(mailKind ? { mailKind } : {}),
});

const fact = (kind: Fact["kind"], value: string, time?: string): Fact => ({
  id: `${kind}:${value}`,
  kind,
  document: "other",
  value,
  ...(time ? { time } : {}),
  source: "model",
  confidence: 0.45,
});

describe("scoreReader", () => {
  it("the scorer counts a missing fact against recall and an extra one against precision", async () => {
    const cases = [
      evalCase("a", [{ kind: "due", value: "2027-04-10" }, { kind: "event", value: "2027-05-01", time: "19:00" }]),
      evalCase("b", []),
    ];
    const answers: Record<string, Fact[]> = {
      // One right, one with the wrong clock, so a miss and an extra.
      a: [fact("due", "2027-04-10"), fact("event", "2027-05-01", "18:00")],
      // Something where nothing was expected: an extra.
      b: [fact("expiry", "2030-01-01")],
    };
    const score = await scoreReader(cases, async (c) => answers[c.id]!, "dates");
    expect(score.precision).toBeCloseTo(1 / 3);
    expect(score.recall).toBeCloseTo(1 / 2);
    expect(score.perCase.find((c) => c.id === "a")).toMatchObject({ found: 1, missed: 1, extra: 1 });
  });

  it("amounts are scored apart from dates", async () => {
    const cases = [evalCase("a", [{ kind: "amount", value: "65.00" }, { kind: "due", value: "2027-04-10" }])];
    const score = await scoreReader(cases, async () => [fact("amount", "65.00")], "amounts");
    expect(score).toMatchObject({ precision: 1, recall: 1 });
  });

  it("a reader that says nothing is not wrong, only incomplete", async () => {
    const score = await scoreReader([evalCase("a", [{ kind: "due", value: "2027-04-10" }])], async () => [], "dates");
    expect(score).toMatchObject({ precision: 1, recall: 0 });
  });
});

describe("scoreKinds", () => {
  it("counts how often the kind of an email is named right", async () => {
    const cases = [evalCase("a", [], "bill"), evalCase("b", [], "newsletter"), evalCase("c", [])];
    const score = await scoreKinds(cases, async (c) => (c.id === "a" ? "bill" : "booking"));
    // c carries no expected kind and is not counted.
    expect(score).toMatchObject({ accuracy: 0.5, cases: 2 });
  });
});
