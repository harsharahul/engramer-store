import { describe, expect, it } from "vitest";
import type { Fact } from "../facts";
import { EMAIL_MIME } from "../../mail/kind";
import { EVAL_CASES } from "./cases";
import { factCases, kindCases, scoreKinds, scoreReader, type EvalCase } from "./score";

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

  it("measures each kind's precision: how often the kind was right when the reader named it", async () => {
    const cases = [evalCase("a", [], "bill"), evalCase("b", [], "newsletter"), evalCase("c", [], "newsletter")];
    // The reader calls the bill a newsletter and one newsletter a booking.
    const named: Record<string, string> = { a: "newsletter", b: "newsletter", c: "booking" };
    const score = await scoreKinds(cases, async (c) => named[c.id]!);
    expect(score.byKind.newsletter).toEqual({ precision: 0.5, offered: 2 });
    expect(score.byKind.booking).toEqual({ precision: 0, offered: 1 });
    expect(score.byKind.bill).toBeUndefined();
  });
});

describe("which cases score which task", () => {
  it("the model's dates are scored on every case the app asks it dates for", () => {
    const ids = factCases(EVAL_CASES).map((c) => c.id);
    // An invite or a passport is read by the model for dates as well.
    expect(ids).toEqual(expect.arrayContaining(["invite-review", "passport-specimen", "guesthouse-plain"]));
    // Mail that carries booking data is not asked for dates.
    expect(ids).not.toContain("flight-aquila");
  });

  it("the mail kind is scored on every email, booking mail too, and on nothing else", () => {
    const emails = EVAL_CASES.filter((c) => c.mime === EMAIL_MIME);
    expect(kindCases(EVAL_CASES).map((c) => c.id)).toEqual(emails.map((c) => c.id));
    expect(EVAL_CASES.filter((c) => c.mailKind !== undefined && c.mime !== EMAIL_MIME).map((c) => c.id)).toEqual([]);
  });
});
