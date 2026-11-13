import { describe, expect, it } from "vitest";
import type { Fact } from "../facts";
import { EMAIL_MIME } from "../../mail/kind";
import { EVAL_CASES } from "./cases";
import { errorsByClass, factCases, kindCases, measure, scoreAsked, scoreKinds, scoreNoise, scoreReader, scoreRoles, type EvalCase } from "./score";

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

describe("scoreRoles", () => {
  it("roles are scored against the expected role of each date found", async () => {
    const cases = [
      evalCase("stay", [
        { kind: "event", value: "2027-04-08", time: "15:00", role: "check-in" },
        { kind: "event", value: "2027-04-12", time: "11:00", role: "check-out" },
      ]),
    ];
    const score = await scoreRoles(cases, async () => [
      { ...fact("event", "2027-04-08", "15:00"), label: "Room ready", subject: { role: "check-in" } },
      // The right date with the wrong role counts against precision.
      { ...fact("event", "2027-04-12", "11:00"), label: "Key at reception", subject: { role: "check-in" } },
    ]);
    expect(score).toEqual({ precision: 0.5, recall: 0.5, offered: 2, expected: 2 });
  });

  it("a role the label states counts like a stated one, as the app reads it", async () => {
    const cases = [evalCase("stay", [{ kind: "event", value: "2027-04-08", role: "check-in" }])];
    const score = await scoreRoles(cases, async () => [{ ...fact("event", "2027-04-08"), label: "Check-in" }]);
    expect(score).toEqual({ precision: 1, recall: 1, offered: 1, expected: 1 });
  });
});

describe("scoreNoise", () => {
  it("counts what a reader offers for documents that state nothing", async () => {
    const cases = [evalCase("quiet", []), evalCase("loud", []), evalCase("bill", [{ kind: "due", value: "2027-04-10" }])];
    const answers: Record<string, Fact[]> = {
      quiet: [],
      loud: [fact("due", "2027-01-01"), fact("amount", "5.00")],
      // A wrong date on a document that does state something is an extra, not noise.
      bill: [fact("due", "2027-04-11")],
    };
    expect(await scoreNoise(cases, async (c) => answers[c.id]!)).toEqual({ cases: 2, loud: 1, offered: 2, rate: 0.5 });
  });

  it("a set with no empty document has no noise to measure", async () => {
    const cases = [evalCase("bill", [{ kind: "due", value: "2027-04-10" }])];
    expect(await scoreNoise(cases, async () => [fact("due", "2027-04-10")])).toEqual({ cases: 0, loud: 0, offered: 0, rate: 0 });
  });
});

describe("measure", () => {
  it("one set's figures: dates, amounts, roles and noise, each with the readings it rests on", async () => {
    const cases = [
      evalCase("stay", [{ kind: "event", value: "2027-04-08", time: "15:00", role: "check-in" }, { kind: "amount", value: "842.00" }]),
      evalCase("bill", [{ kind: "due", value: "2027-04-10" }]),
      evalCase("news", []),
    ];
    const answers: Record<string, Fact[]> = {
      stay: [{ ...fact("event", "2027-04-08", "15:00"), subject: { role: "check-in" } }, fact("amount", "842.00")],
      bill: [],
      news: [fact("expiry", "2027-06-30")],
    };
    const figures = await measure(cases, async (c) => answers[c.id]!, () => Date.UTC(2027, 3, 1, 12));
    // On 1 April 2027 the stay and the stray expiry are ahead: two questions, one of them wrong.
    expect(figures.asked).toEqual({ documents: 3, asked: 2, wrong: 1, untyped: 0, askedPer100: 66.7, wrongPer100: 33.3 });
    expect(figures.dates).toEqual({ precision: 0.5, recall: 0.5, offered: 2, expected: 2 });
    expect(figures.amounts).toEqual({ precision: 1, recall: 1, offered: 1, expected: 1 });
    expect(figures.roles).toEqual({ precision: 1, recall: 1, offered: 1, expected: 1 });
    expect(figures.noise).toEqual({ cases: 1, loud: 1, offered: 1, rate: 1 });
    // The cases that missed or added something, for the run's report.
    expect(figures.wrong.map((c) => c.id)).toEqual(["bill", "news"]);
  });

  it("mail that states its facts as data is not asked for them, so it is not measured", async () => {
    const booked: EvalCase = { ...evalCase("flight", [{ kind: "event", value: "2027-03-04" }]), exact: true };
    const figures = await measure([booked], async () => [], () => Date.UTC(2027, 3, 1, 12));
    expect(figures.dates).toEqual({ precision: 1, recall: 1, offered: 0, expected: 0 });
  });
});

describe("errorsByClass", () => {
  it("each wrong reading falls in exactly one class, and what nothing explains is missed", async () => {
    const cases = [
      evalCase("statement", [{ kind: "due", value: "2027-04-10" }]),
      evalCase("renewal", [{ kind: "due", value: "2027-08-01" }]),
      evalCase("ticket", [{ kind: "event", value: "2027-05-15", time: "08:42" }]),
      evalCase("invoice", [{ kind: "amount", value: "79.99" }]),
      evalCase("newsletter", []),
      evalCase("silent", [{ kind: "event", value: "2027-06-01" }]),
    ];
    const answers: Record<string, Fact[]> = {
      // A form line that only names a date; the due day itself was not read.
      statement: [{ ...fact("dated", "2027-03-03"), label: "Statement date" }],
      // The right day, called an expiry.
      renewal: [fact("expiry", "2027-08-01")],
      // The right day and kind, without its clock.
      ticket: [fact("event", "2027-05-15")],
      // A part of the invoice in place of its total.
      invoice: [fact("amount", "20.00")],
      // A day that is nobody's business.
      newsletter: [fact("event", "2027-04-03")],
      silent: [],
    };
    expect(await errorsByClass(cases, async (c) => answers[c.id]!)).toEqual({
      "named-only line": { count: 1, cases: ["statement"] },
      "wrong meaning": { count: 1, cases: ["renewal"] },
      "clock missing": { count: 1, cases: ["ticket"] },
      "part for the total": { count: 1, cases: ["invoice"] },
      "not the reader's business": { count: 1, cases: ["newsletter"] },
      // The renewal and the ticket were found, wrongly; they are not missed twice.
      missed: { count: 3, cases: ["statement", "invoice", "silent"] },
    });
  });

  it("a reading that is right is in no class", async () => {
    const cases = [evalCase("bill", [{ kind: "due", value: "2027-04-10" }, { kind: "amount", value: "84.20" }])];
    const classes = await errorsByClass(cases, async () => [fact("due", "2027-04-10"), fact("amount", "84.20")]);
    expect(Object.values(classes).every((entry) => entry.count === 0)).toBe(true);
  });
});

describe("scoreAsked: the questions a person would be shown", () => {
  // Every document below is looked at on 1 April 2027, the day it reached the reader.
  const onApril1 = () => Date.UTC(2027, 3, 1, 12);

  it("a question is what the app would ask on the document's own day", async () => {
    const cases = [
      evalCase("ahead", [{ kind: "due", value: "2027-04-10" }]),
      evalCase("long-over", [{ kind: "due", value: "2027-01-05" }]),
      evalCase("answered", [{ kind: "due", value: "2027-04-12" }]),
    ];
    const answers: Record<string, Fact[]> = {
      // Ahead and unanswered: it asks.
      ahead: [fact("due", "2027-04-10")],
      // Nearly three months behind: the app never asks about it.
      "long-over": [fact("due", "2027-01-05")],
      // Already confirmed: nothing left to ask.
      answered: [{ ...fact("due", "2027-04-12"), confirmed: true }],
    };
    expect(await scoreAsked(cases, async (c) => answers[c.id]!, onApril1)).toEqual({ documents: 3, asked: 1, wrong: 0, untyped: 0, askedPer100: 33.3, wrongPer100: 0 });
  });

  it("a named-only line on an expected day is untyped; on another day it is wrong", async () => {
    const cases = [evalCase("ticket", [{ kind: "event", value: "2027-05-15", time: "08:42" }])];
    const lines: Fact[] = [
      { ...fact("dated", "2027-05-15"), label: "Date", source: "label", confidence: 0.4 },
      { ...fact("dated", "2027-04-20"), label: "Booked on", source: "label", confidence: 0.4 },
    ];
    expect(await scoreAsked(cases, async () => lines, onApril1)).toMatchObject({ asked: 2, untyped: 1, wrong: 1 });
  });

  it("the right day under the wrong meaning is a wrong question", async () => {
    const cases = [evalCase("renewal", [{ kind: "due", value: "2027-08-01" }])];
    expect(await scoreAsked(cases, async () => [fact("expiry", "2027-08-01")], onApril1)).toMatchObject({ asked: 1, wrong: 1, untyped: 0 });
  });

  it("an amount asks nothing on its own, and the numbers are per 100 documents", async () => {
    const cases = [evalCase("a", []), evalCase("b", []), evalCase("c", []), evalCase("d", [{ kind: "due", value: "2027-04-10" }])];
    const answers: Record<string, Fact[]> = {
      a: [fact("amount", "45.00")],
      b: [fact("event", "2027-04-03")],
      c: [],
      d: [fact("due", "2027-04-10")],
    };
    expect(await scoreAsked(cases, async (c) => answers[c.id]!, onApril1)).toEqual({ documents: 4, asked: 2, wrong: 1, untyped: 0, askedPer100: 50, wrongPer100: 25 });
  });
});
